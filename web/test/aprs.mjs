/**
 * APRS receiver (Bell 202 AFSK + AX.25).
 *
 * The evidence is synthetic and built from the transmit side: the same ax25Aprs / ax25Bits encoder the Troll and
 * APRS-beacon apps use makes the on-air bit levels (HDLC flags, LSB-first bytes, bit-stuffing, NRZI), those levels
 * are played out as continuous-phase Bell 202 tones (mark 1200 Hz, space 2200 Hz, 1200 baud), FM-modulated at the
 * ±3.5 kHz the beacon uses, and put through the very atan2 discriminator the worker runs — so AprsDecoder.onFm sees
 * radians per sample at the intermediate rate, exactly what it gets on air.
 *
 * The modulator's premises are checked first (frame FCS, tone cycles per bit, discriminator scale) because a
 * builder that is wrong the same way as the decoder would prove nothing.
 */
import { ax25Aprs, ax25Bits } from '../dist/tx-encoders.js';
import { AprsDecoder } from '../dist/dsp/aprs.js';
import { HdlcFramer } from '../dist/dsp/core.js';

const RATE = 48000, BAUD = 1200, MARK = 1200, SPACE = 2200, DEV = 3500;

let pass = 0, fail = 0;
const ok = (c, what, extra = '') => { if (c) { pass++; } else { fail++; console.log(`  FAIL ${what}${extra ? ' — ' + extra : ''}`); } };
const near = (a, b, tol, what) => ok(Math.abs(a - b) <= tol, what, `got ${a}, want ${b}±${tol}`);

const rng = (seed) => { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 - 0.5; }; };

// NRZI tone levels -> continuous-phase AFSK audio (real, unit amplitude).
const afsk = (levels, rate = RATE) => {
  const spb = rate / BAUD, out = new Float32Array(Math.round(levels.length * spb));
  let ph = 0, k = 0;
  for (const lvl of levels) {
    const w = 2 * Math.PI * (lvl ? MARK : SPACE) / rate;
    for (let i = 0; i < spb; i++) { out[k++] = Math.sin(ph); ph += w; if (ph > 2 * Math.PI) ph -= 2 * Math.PI; }
  }
  return out;
};

// FM-modulate an audio signal to complex baseband, then discriminate it back the way the worker does.
const throughFm = (audio, rate = RATE, devHz = DEV, noise = 0, seed = 7) => {
  const rnd = rng(seed);
  const re = new Float32Array(audio.length), im = new Float32Array(audio.length);
  let ph = 0;
  for (let i = 0; i < audio.length; i++) { ph += 2 * Math.PI * devHz * audio[i] / rate; re[i] = Math.cos(ph) + noise * rnd(); im[i] = Math.sin(ph) + noise * rnd(); }
  const disc = new Float32Array(audio.length);
  let pI = 1, pQ = 0;
  for (let i = 0; i < audio.length; i++) { const a = re[i], b = im[i]; disc[i] = Math.atan2(b * pI - a * pQ, a * pI + b * pQ); pI = a; pQ = b; }
  return disc;
};

const run = (source, info, { flags = 64, noise = 0 } = {}) => {
  const frame = ax25Aprs(source, info);
  const disc = throughFm(afsk(ax25Bits(frame, flags)), RATE, DEV, noise);
  const packets = []; let stations = [];
  const dec = new AprsDecoder(m => { if (m.type === 'packet') packets.push(m.line); if (m.type === 'stations') stations = m.rows; });
  dec.reset(RATE);
  for (let o = 0; o < disc.length; o += 4096) { const n = Math.min(4096, disc.length - o); dec.onFm(disc.subarray(o, o + n), n, RATE); }
  return { frame, packets, stations };
};

// --- premises -------------------------------------------------------------------------------------------------
const fr = ax25Aprs('N0CALL-9', '!4903.50N/07201.75W-Test');
ok(HdlcFramer.fcsOk(Uint8Array.from(fr)), 'encoder FCS closes (data+FCS -> 0xF0B8)');
ok(afsk([true]).length === RATE / BAUD, 'one bit spans rate/baud audio samples');
// after the FM round-trip a mark tone must still read as 1200 Hz, not 2200 — the property the decoder relies on.
const goertzel = (sig, hz) => { let c = 0, s = 0; for (let i = 50; i < sig.length; i++) { const w = 2 * Math.PI * hz * i / RATE; c += sig[i] * Math.cos(w); s += sig[i] * Math.sin(w); } return c * c + s * s; };
const steady = throughFm(afsk(new Array(200).fill(true)));
ok(goertzel(steady, MARK) > goertzel(steady, SPACE) * 4, 'a mark tone survives FM+discriminator as 1200 Hz');

// --- decode: the packet types the UI shows --------------------------------------------------------------------
const pos = run('N0CALL-9', '!4903.50N/07201.75W-Test');
ok(pos.packets.some(p => p.startsWith('N0CALL-9>APZMHM:!4903.50N/07201.75W-Test')), 'uncompressed position decodes');
ok(pos.stations.some(x => x.call === 'N0CALL-9' && Math.abs((x.lat ?? 0) - 49.0583) < 0.01 && Math.abs((x.lon ?? 0) + 72.0292) < 0.01), 'lat/lon parsed');

const status = run('W1AW', '>NET tonight 7pm');
ok(status.packets.some(p => p.startsWith('W1AW>APZMHM:>NET tonight 7pm')), 'status text decodes');

const msg = run('K1ABC-1', ':N0CALL-9 :hello world{1');
ok(msg.stations.some(x => x.call === 'K1ABC-1' && x.lastMsg && x.lastMsg.text === 'hello world'), 'message parsed');

const wx = run('W6XYZ', '!4903.50N/07201.75W_270/010g015t072h50');
ok(wx.stations.some(x => x.call === 'W6XYZ' && x.wx && x.wx.tempF === 72 && x.wx.windDir === 270), 'weather fields parsed');

const noisy = run('N0CALL-9', '!4903.50N/07201.75W-Test', { noise: 0.25 });
ok(noisy.packets.length >= 1, 'decodes through moderate noise');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
