/**
 * LoRa scanner bench (not part of `npm test`): noise plus one real Meshtastic LongFast frame at the rates the iOS
 * app opens the LoRa app at (Apps.swift): 20 Msps on the band's center when the radio can sample that wide
 * (HackRF), else 2 Msps with the band's main channel 300 kHz below the center (RTL-SDR). Prints the processing time
 * as a percentage of real time, single-threaded, everything inline in onIq (no load shedding), then the wide case
 * again with the app's load shedding on (what a browser tab would see).
 *
 *   node test/lora-bench.mjs [seconds of noise before and after, default 1]
 */
import { readFileSync } from 'node:fs';
import { LoraHub } from '../dist/dsp/lora/hub.js';
import { fft } from '../dist/fft.js';

const pad = Number(process.argv[2] ?? 1);
const LONGFAST_US = 906_875_000;

/** The 250 kHz clip at `rate` (FFT-upsampled to 2 Msps, then a windowed-sinc interpolator for higher rates). */
function clipAt(rate) {
  const raw = new Int8Array(readFileSync(new URL('./resources/meshtastic_nodeinfo_a_250k_sf11.i8', import.meta.url)).buffer.slice(0));
  const n = raw.length / 2;
  let big = 1; while (big < n) big <<= 1;
  const re = new Float32Array(big), im = new Float32Array(big);
  for (let k = 0; k < n; k++) { re[k] = raw[2 * k]; im[k] = raw[2 * k + 1]; }
  fft(re, im);
  const m = big * 8;
  const r2 = new Float32Array(m), i2 = new Float32Array(m);
  for (let k = 0; k < big; k++) { const dst = k < big / 2 ? k : m - (big - k); r2[dst] = re[k]; i2[dst] = -im[k]; }
  fft(r2, i2);
  const s = 0.3 / big;
  const x2 = new Float32Array(2 * m);
  for (let k = 0; k < m; k++) { x2[2 * k] = r2[k] * s; x2[2 * k + 1] = -i2[k] * s; }
  if (rate === 2_000_000) return x2;
  const L = rate / 2_000_000, T = 16, out = new Float32Array(2 * m * L);
  const h = new Float32Array(L * T);
  for (let ph = 0; ph < L; ph++) for (let k = 0; k < T; k++) {
    const x = k - T / 2 + 1 - ph / L, u = (x + T / 2) / T;
    const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
    h[ph * T + k] = sinc * (u <= 0 || u >= 1 ? 0 : 0.42 - 0.5 * Math.cos(2 * Math.PI * u) + 0.08 * Math.cos(4 * Math.PI * u));
  }
  for (let i = 0; i < m; i++) for (let ph = 0; ph < L; ph++) {
    let a = 0, b = 0;
    for (let k = 0; k < T; k++) { const j = i - T / 2 + 1 + k; if (j < 0 || j >= m) continue; a += h[ph * T + k] * x2[2 * j]; b += h[ph * T + k] * x2[2 * j + 1]; }
    out[2 * (i * L + ph)] = a; out[2 * (i * L + ph) + 1] = b;
  }
  return out;
}

function signal(rate, offHz) {
  const clip = clipAt(rate), m = clip.length / 2, lead = Math.round(pad * rate), total = lead + m + lead;
  const bytes = new Int8Array(2 * total);
  let seed = 1;
  const noise = () => { seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0; return (seed >>> 8) / (1 << 24) - 0.5; };
  const w = 2 * Math.PI * offHz / rate;
  for (let k = 0; k < total; k++) {
    let x = 6 * noise(), y = 6 * noise();
    const s = k - lead;
    if (s >= 0 && s < m) { const a = clip[2 * s], b = clip[2 * s + 1], c = Math.cos(w * k), d = Math.sin(w * k); x += a * c - b * d; y += a * d + b * c; }
    bytes[2 * k] = Math.max(-128, Math.min(127, Math.round(x)));
    bytes[2 * k + 1] = Math.max(-128, Math.min(127, Math.round(y)));
  }
  return { bytes, lead, m, total };
}

function bench(label, rate, center, shedding = false) {
  const { bytes, lead, m, total } = signal(rate, LONGFAST_US - center);
  const msgs = [];
  const hub = new LoraHub(x => msgs.push(x));
  hub.scanner.shedding = shedding;   // off: measure everything; on: the app's own behavior (the channels lag and skip once the time is up)
  hub.setCenter(center);
  hub.reset(rate);
  // the radio's buffers: 256 KiB of IQ (131072 samples) per transfer at 20 Msps, 32 KiB at 2 Msps
  const chunk = 2 * (rate >= 10_000_000 ? 131_072 : 16_384);
  const parts = [['noise', 0, lead], ['frame', lead, lead + m], ['noise', lead + m, total]];
  const times = [];
  for (const [, a, b] of parts) {
    const t0 = performance.now();
    for (let at = 2 * a; at < 2 * b; at += chunk) hub.onIq(bytes.subarray(at, Math.min(2 * b, at + chunk)), rate);
    times.push((performance.now() - t0) / 1000);
  }
  const air = parts.map(([, a, b]) => (b - a) / rate);
  const all = times.reduce((x, y) => x + y) / air.reduce((x, y) => x + y);
  hub.flush();
  const snap = msgs.filter(x => x.type === 'lora').pop();
  const decoded = msgs.filter(x => x.type === 'packet').map(x => x.line);
  console.log(`${label}: ${rate / 1e6} Msps, center ${(center / 1e6).toFixed(3)} MHz, ${snap.channels.length} plan channels in span, ${snap.channels.filter(c => c.standing).length} standing`);
  console.log(`  noise before ${(100 * times[0] / air[0]).toFixed(0)}% · during the frame ${(100 * times[1] / air[1]).toFixed(0)}% · noise after ${(100 * times[2] / air[2]).toFixed(0)}% · overall ${(100 * all).toFixed(0)}% of real time`);
  console.log(`  frames: ${decoded.length ? decoded.join(' | ') : 'none'}`);
  return all;
}

bench('HackRF (wide)', 20_000_000, 913_000_000);
bench('RTL-SDR (narrow)', 2_000_000, LONGFAST_US + 300_000);
bench('HackRF (wide), load shedding on', 20_000_000, 913_000_000, true);
