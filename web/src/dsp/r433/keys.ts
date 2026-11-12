/**
 * Car keys, gate and garage remotes, and Mayhem's weather sensors, read from one tuned channel.
 *
 * These decoders (Mayhem's subghzd protocols and ProtoPirate's car keys) want a plain list of levels and how long
 * each lasted. The slicer below makes two such lists from a channel's envelope and discriminator: one for the
 * carrier going on and off, one for the frequency going high and low while the carrier is up. Each decoder reads
 * the list that matches how its device transmits; the frequency-keyed car keys read both polarities, since which
 * tone a fob calls "high" varies.
 */

import { Fam, type FProto } from '../ism/base.js';
import { allProtos } from '../ism/registry.js';
import { parseWeather } from '../ism/weather-fields.js';
import { parseRemote } from '../ism/remote-fields.js';
import { parseCar } from '../ism/car-fields.js';
import type { PPDecoder, PPHit } from '../ism/pirate/pp-base.js';
import { ppAll } from '../ism/pirate/protos.js';

/** What a key, remote or sensor said, ready to list. */
export interface KeyReading {
  family: 'key' | 'remote' | 'weather';
  model: string;
  /** The transmitter's own identity, when it has one (serial, ID). Empty when it does not. */
  id: string;
  /** Everything else decoded, in order, as label and value. */
  fields: [string, string][];
  /** The frame as received, hex, for de-duplication and the detail card. */
  raw: string;
  bits: number;
}

/**
 * A carrier's first samples are held back until both of its tones have shown up (or this many have gone by, 2 ms
 * at 250 kHz): only then is the middle between them known, and the held samples are read against it, so the
 * opening of the preamble is not lost however long its first symbol is.
 */
const SETTLE_MAX = 512;
/** Less shift than this (in discriminator units, about 2 kHz at 250 kHz) is a plain carrier, not two tones. */
const MIN_SPREAD = 500;
/** How many samples late the smoothed envelope says a carrier came up. */
const LAG = 5;
const RECENT = 32;

const hex = (v: bigint, w = 1) => v.toString(16).toUpperCase().padStart(w, '0');

/**
 * Levels and durations from one channel. A carrier is present while the envelope stands about ten decibels over
 * the noise (seven to let go, so a dip does not chop a mark in two); while it is, the frequency is "high" above
 * its own running middle, which tracks wherever in the channel the transmitter actually sits.
 */
export class KeySlicer {
  private usPer = 4;
  private noise = 0; private noiseN = 0;
  private on = false; private fmHi = 0; private fmLo = 0; private bufHi = 0; private away = 0; private skip = 0;
  private readonly recent = new Float32Array(RECENT); private recentAt = 0;
  private readonly settle: number[] = []; private settled = true;
  private ookLvl = false; private ookRun = 0;
  private fmLvl = false; private fmRun = 0;

  constructor(private readonly onOok: (level: boolean, us: number) => void, private readonly onFsk: (level: boolean, us: number) => void) {}

  reset(rate: number): void {
    this.usPer = 1e6 / rate;
    this.noise = 0; this.noiseN = 0; this.on = false; this.fmHi = 0; this.fmLo = 0;
    this.recent.fill(0); this.recentAt = 0; this.settle.length = 0; this.settled = true;
    this.ookLvl = false; this.ookRun = 0; this.fmLvl = false; this.fmRun = 0;
  }

  process(env: Int16Array, fm: Int16Array, n: number): void {
    const usPer = this.usPer, recent = this.recent;
    for (let i = 0; i < n; i++) {
      const e = env[i], f = fm[i];
      recent[this.recentAt] = f; this.recentAt = (this.recentAt + 1) & (RECENT - 1);
      if (!this.on) {
        // the noise level, settled quickly at first and slowly after
        this.noiseN++;
        this.noise += (e - this.noise) / (this.noiseN < 256 ? this.noiseN : 256);
      }
      if (!this.on && this.noiseN > 64 && e > this.noise * 3.2) {
        this.on = true;
        // The envelope is smoothed, so it crosses the line a few samples after the carrier really came up: those
        // samples belong to the mark, in both streams, and they start the frequency's settling.
        const back = Math.min(LAG, this.ookLvl ? 0 : this.ookRun - 1, this.fmRun - 1);
        if (this.ookRun - back > 0) this.onOok(false, Math.round((this.ookRun - back) * usPer));
        this.ookLvl = true; this.ookRun = back;
        this.fmRun -= back;
        this.settle.length = 0; this.bufHi = 0; this.away = 0;
        for (let k = back; k >= 1; k--) this.settle.push(recent[(this.recentAt - 1 - k + RECENT * 2) & (RECENT - 1)]);
        this.skip = this.settle.length + 3;
        this.settled = false;
      } else if (this.on && e < this.noise * 2.2) this.on = false;
      const on = this.on;
      if (on === this.ookLvl) this.ookRun++;
      else { this.onOok(this.ookLvl, Math.round(this.ookRun * usPer)); this.ookLvl = on; this.ookRun = 1; }
      // The first few samples of a carrier only settle the middle and the size of the shift; once they have, they
      // are read with the rest, so none of the mark is lost to it.
      if (on && !this.settled) {
        this.hold(f);
        if (this.settle.length >= SETTLE_MAX || this.away >= 4) this.release();
        continue;
      }
      if (!on && !this.settled && this.settle.length) this.release();
      this.fsk(f, on);
    }
  }

  private hold(f: number): void {
    this.settle.push(f);
    // Skipping the backdated samples and the first few after them, while the discriminator swings in from the
    // noise: the first tone is the running average of what is held; the second has arrived once the frequency
    // has stood well away from it for several samples running.
    const k = this.settle.length - this.skip;
    if (k <= 0) return;
    if (k <= 8) { this.bufHi += (f - this.bufHi) / k; return; }
    if (Math.abs(f - this.bufHi) > MIN_SPREAD * 2) this.away++;
    else { this.away = 0; this.bufHi += (f - this.bufHi) / k; }
  }

  /** Both tones are in (or it is a plain carrier): set the extremes from the held samples, then read them in order. */
  private release(): void {
    const s = this.settle;
    // the two tones: the average of the held samples on each side of the middle between the first tone and the
    // newest samples (a plain carrier has only the one)
    const from = Math.min(this.skip, s.length - 1);
    const second = this.away >= 4 ? (s[s.length - 1] + s[s.length - 2] + s[s.length - 3] + s[s.length - 4]) / 4 : this.bufHi;
    const t = (this.bufHi + second) / 2;
    let hi = 0, nh = 0, lo = 0, nl = 0;
    for (let i = from; i < s.length; i++) { if (s[i] > t) { hi += s[i]; nh++; } else { lo += s[i]; nl++; } }
    this.fmHi = nh ? hi / nh : t; this.fmLo = nl ? lo / nl : t;
    this.away = 0; this.bufHi = 0;
    // the backdated and first few samples are the carrier coming up through the noise: they read as the first clean one
    for (let i = 0; i < from; i++) s[i] = s[from];
    this.settled = true;
    for (const v of s) this.fsk(v, true);
    s.length = 0;
  }

  /**
   * One sample of the frequency stream. The two tones are tracked as a high and a low that jump quickly to a new
   * extreme and relax slowly; the level is high above the middle between them, and flips only once the
   * frequency is well past it, so noise riding on one tone cannot flicker it.
   */
  private fsk(f: number, on: boolean): void {
    let l = false;
    if (on) {
      this.fmHi += (f - this.fmHi) * (f > this.fmHi ? 0.25 : 1 / 256);
      this.fmLo += (f - this.fmLo) * (f < this.fmLo ? 0.25 : 1 / 256);
      const spread = this.fmHi - this.fmLo, mid = (this.fmHi + this.fmLo) / 2, h = spread * 0.15;
      l = spread < MIN_SPREAD ? false : f > mid + h ? true : f < mid - h ? false : this.fmLvl;
    }
    if (l === this.fmLvl) this.fmRun++;
    else { this.onFsk(this.fmLvl, Math.round(this.fmRun * this.usPer)); this.fmLvl = l; this.fmRun = 1; }
  }

  /** End whatever is in flight with a long silence, so every decoder finishes its frame. */
  flush(): void {
    const usPer = this.usPer;
    if (this.ookRun) this.onOok(this.ookLvl, Math.round(this.ookRun * usPer));
    if (this.fmRun) this.onFsk(this.fmLvl, Math.round(this.fmRun * usPer));
    this.onOok(false, 50_000); this.onFsk(false, 50_000);
    this.ookLvl = false; this.ookRun = 0; this.fmLvl = false; this.fmRun = 0; this.on = false;
  }
}

/** One full set of decoders, fed by one slicer. */
export class KeyDecoders {
  readonly slicer: KeySlicer;
  private readonly protos: FProto[];
  private readonly pirAm: PPDecoder[];
  private readonly pirFm: PPDecoder[];
  private readonly pirFmInv: PPDecoder[];

  constructor(private readonly onReading: (r: KeyReading) => void) {
    this.protos = allProtos();
    for (const p of this.protos) p.callback = (q) => this.onHit(q);
    const pp = ppAll();
    this.pirAm = pp.am; this.pirFm = pp.fm; this.pirFmInv = ppAll().fm;
    for (const p of [...this.pirAm, ...this.pirFm, ...this.pirFmInv]) p.onHit = (h) => this.onPirate(h);
    this.slicer = new KeySlicer(
      (l, us) => { for (const p of this.protos) p.feed(l, us); for (const p of this.pirAm) p.feed(l, us); },
      (l, us) => { for (const p of this.pirFm) p.feed(l, us); for (const p of this.pirFmInv) p.feed(!l, us); });
  }

  /**
   * A new burst on a fresh channel: every car-key decoder starts clean. ProtoPirate's own "same frame as last
   * time" filter is for repeats within one transmission; across bursts, repeats are merged by the receiver.
   */
  reset(): void { for (const p of [...this.pirAm, ...this.pirFm, ...this.pirFmInv]) p.reset(); }

  private onPirate(h: PPHit): void {
    const fields: [string, string][] = [];
    if (h.btn) fields.push(['BUTTON', h.btn]);
    if (h.cnt !== null) fields.push(['COUNTER', h.cnt.toString()]);
    for (const f of h.fields) fields.push([f.name.toUpperCase(), f.value]);
    this.onReading({ family: 'key', model: h.name, id: h.serial !== null ? hex(h.serial) : '', fields, raw: h.key, bits: h.bits });
  }

  private onHit(p: FProto): void {
    const raw = hex(p.decodeData) + (p.decodeData2 !== 0n ? hex(p.decodeData2) : '');
    if (p.family === Fam.WEATHER) {
      const w = parseWeather(p.sensorType, p.decodeData);
      const fields: [string, string][] = [];
      if (w.temp !== null) fields.push(['TEMPERATURE', `${w.temp.toFixed(1)} °C · ${(w.temp * 9 / 5 + 32).toFixed(1)} °F`]);
      if (w.humidity !== null) fields.push(['HUMIDITY', `${w.humidity}%`]);
      if (w.channel !== null) fields.push(['CHANNEL', String(w.channel)]);
      if (w.batteryLow !== null) fields.push(['BATTERY', w.batteryLow ? 'low' : 'OK']);
      this.onReading({ family: 'weather', model: w.name, id: w.id.toString(), fields, raw, bits: p.dataCountBit });
    } else if (p.family === Fam.REMOTE) {
      const r = parseRemote(p.sensorType, p.decodeData, p.dataCountBit);
      const fields: [string, string][] = [];
      if (r.btn !== null) fields.push(['BUTTON', String(r.btn)]);
      if (r.cnt !== null) fields.push(['COUNTER', String(r.cnt)]);
      for (const e of r.extra) { const i = e.indexOf(' '); fields.push(i > 0 ? [e.slice(0, i).toUpperCase(), e.slice(i + 1)] : ['NOTE', e]); }
      this.onReading({ family: 'remote', model: r.name, id: r.serial !== 0n ? hex(r.serial) : '', fields, raw, bits: p.dataCountBit });
    } else {
      const c = parseCar(p.sensorType, p.decodeData, p.decodeData2, p.dataCountBit);
      const fields: [string, string][] = [];
      if (c.btn) fields.push(['BUTTON', c.btn]);
      if (c.cnt !== null) fields.push(['COUNTER', String(c.cnt)]);
      for (const e of c.extra) { const i = e.indexOf(' '); fields.push(i > 0 ? [e.slice(0, i).toUpperCase(), e.slice(i + 1)] : ['NOTE', e]); }
      this.onReading({ family: 'key', model: c.name, id: hex(c.serial), fields, raw, bits: p.dataCountBit });
    }
  }
}
