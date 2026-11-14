/**
 * Replays a raw IQ recording through the whole Sondes receiver and prints what it heard.
 *   node test/sonde-replay.mjs <file> <rate> <centerHz> [u8|s8] [400|1680]
 * u8 = offset-128 bytes (the iPad/Mac dev remote's /iqdump, rtl_sdr), s8 = signed bytes (hackrf_transfer).
 * A file named iq_<rate>_<center>.u8 needs no rate or center.
 */
import { openSync, readSync, fstatSync, closeSync } from 'node:fs';
import { basename } from 'node:path';
import { SondeProcessor } from '../dist/dsp/sonde/front.js';

const [file, rateArg, centerArg, fmtArg, bandArg] = process.argv.slice(2);
if (!file) { console.log('usage: node test/sonde-replay.mjs <file> [rate] [centerHz] [u8|s8] [400|1680]'); process.exit(2); }
const m = /iq_(\d+)_(\d+)\.u8$/.exec(basename(file));
const rate = Number(rateArg ?? m?.[1]), center = Number(centerArg ?? m?.[2]), fmt = fmtArg ?? 'u8';
const band = bandArg ?? (center > 1e9 ? '1680' : '400');
const proc = new SondeProcessor(msg => {
  if (msg.type === 'log') console.log(msg.line);
  else if (msg.type === 'packet') console.log('  ' + msg.line);
});
proc.setBand(band); proc.reset(rate); proc.setCenter(center);
// a narrow recording must not hop away: stand in for the radio that never retunes
proc.hop = () => {};
const fd = openSync(file, 'r'), size = fstatSync(fd).size, chunk = 1 << 18, buf = Buffer.alloc(chunk);
const t0 = Date.now();
for (let pos = 0; pos < size;) {
  const n = readSync(fd, buf, 0, chunk, pos); if (n <= 0) break; pos += n;
  const iq = new Int8Array(n & ~1);
  for (let i = 0; i < iq.length; i++) iq[i] = fmt === 'u8' ? buf[i] - 128 : (buf[i] << 24) >> 24;
  proc.onIq(iq, rate);
}
closeSync(fd);
const secs = size / 2 / rate;
console.log(`\n${secs.toFixed(1)} s of ${(rate / 1e6).toFixed(2)} Msps at ${(center / 1e6).toFixed(4)} MHz in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
for (const s of proc.tracker.rows(Date.now())) console.log(`${s.model ?? s.type} ${s.serial}: ${s.frames} frames, ${(s.hz / 1e6).toFixed(4)} MHz${s.alt !== undefined ? `, ${Math.round(s.alt)} m` : ''}${s.tempC !== undefined ? `, ${s.tempC.toFixed(1)} °C` : ''}`);
