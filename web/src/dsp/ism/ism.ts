/** Sub-GHz OOK receiver (Mayhem proc_weather / proc_subghzd / proc_subcar, rtl_433 style; twin of ism/IsmDecoder.kt), plus an FSK front end for ProtoPirate's FM car keys. */
import type { Emit, IqProcessor } from '../core.js';
import { Fam, type FProto } from './base.js';
import { allProtos } from './registry.js';
import { parseWeather } from './weather-fields.js';
import { parseRemote } from './remote-fields.js';
import { parseCar } from './car-fields.js';
import type { PPDecoder, PPHit } from './pirate/pp-base.js';
import { ppAll } from './pirate/protos.js';

const STATE_IDLE = 0, STATE_PULSE = 1, STATE_GAP_START = 2, STATE_GAP = 3, MIN_HIGH = 4, MAX_HIGH = 60000;
const hex = (v: bigint, w = 8) => v.toString(16).toUpperCase().padStart(w, '0');

export class IsmDecoder implements IqProcessor {
  weather = true; remotes = true; cars = true;
  private readonly protos: FProto[];
  private dcI = 0; private dcQ = 0;
  private dec = 4; private accI = 0; private accQ = 0; private accN = 0;
  private nsPerSamp = 2000;
  private state = STATE_IDLE;
  private lowEstimate = 10; private highEstimate = 1000;
  private numg = 0;
  private currentDurationNs = 0; private currentHiLow = false;
  private readonly seen = new Map<string, number>();
  // ProtoPirate's car-key decoders: AM ones on the OOK pulses, FM ones on the FSK pulses (both polarities, since
  // which tone a fob calls "high" varies)
  private readonly pirAm: PPDecoder[];
  private readonly pirFm: PPDecoder[];
  private readonly pirFmInv: PPDecoder[];
  // FSK front end: phase step between decimated samples, smoothed, sliced around its own running middle
  private fmPrevI = 0; private fmPrevQ = 0; private fmLP = 0; private fmMid = 0;
  private fmWasPresent = false; private fmLevel = false;
  private fmDurNs = 0;

  constructor(private readonly emit: Emit) {
    this.protos = allProtos();
    for (const p of this.protos) p.callback = (q) => this.onHit(q);
    const pp = ppAll();
    this.pirAm = pp.am; this.pirFm = pp.fm; this.pirFmInv = ppAll().fm;
    for (const p of [...this.pirAm, ...this.pirFm, ...this.pirFmInv]) p.onHit = (h) => this.onPirate(h);
  }

  reset(rate: number): void {
    this.dec = Math.max(1, Math.floor(rate / 500000));
    this.nsPerSamp = 1e9 / (rate / this.dec);
    this.accI = this.accQ = this.accN = 0; this.state = STATE_IDLE; this.lowEstimate = 10; this.highEstimate = 1000; this.numg = 0;
    this.currentDurationNs = 0; this.currentHiLow = false;
  }

  onIq(iq: Int8Array): void {
    const nSamp = iq.length >> 1;
    let sI = 0, sQ = 0;
    for (let i = 0; i < nSamp; i++) { sI += iq[2 * i]; sQ += iq[2 * i + 1]; }
    this.dcI += 0.2 * (sI / nSamp - this.dcI); this.dcQ += 0.2 * (sQ / nSamp - this.dcQ);
    for (let i = 0; i < nSamp; i++) {
      this.accI += iq[2 * i] - this.dcI; this.accQ += iq[2 * i + 1] - this.dcQ;
      if (++this.accN < this.dec) continue;
      const ci = this.accI / this.accN, cq = this.accQ / this.accN; this.accI = this.accQ = 0; this.accN = 0;
      this.sample(ci * ci + cq * cq);
      if (this.cars) this.fmSample(ci, cq);
    }
  }

  private sample(mag: number): void {
    const threshold = (this.lowEstimate + this.highEstimate) / 2;
    const hysteresis = threshold / 8;
    let meashl = this.currentHiLow;
    switch (this.state) {
      case STATE_IDLE:
        if (mag > threshold + hysteresis) { meashl = true; this.state = STATE_PULSE; this.numg = 0; }
        else {
          meashl = false;
          const delta = mag - this.lowEstimate;
          this.lowEstimate += delta / 5;
          this.lowEstimate += delta > 0 ? 0.01 : -0.01;
          if (this.lowEstimate < 0.5) this.lowEstimate = 0.5;
          this.highEstimate = Math.min(MAX_HIGH, Math.max(MIN_HIGH, 1.35 * this.lowEstimate));
        }
        break;
      case STATE_PULSE:
        if (++this.numg > 100) this.numg = 100;
        if (mag < threshold - hysteresis) {
          if (this.numg < 3) this.state = STATE_GAP; else { this.numg = 0; this.state = STATE_GAP_START; }
          meashl = false;
        } else {
          this.highEstimate += mag / 3 - this.highEstimate / 3;
          this.highEstimate = Math.min(MAX_HIGH, Math.max(MIN_HIGH, this.highEstimate));
          meashl = true;
        }
        break;
      case STATE_GAP_START:
        ++this.numg;
        if (mag > threshold + hysteresis) { this.state = STATE_PULSE; meashl = true; }
        else if (this.numg >= 3) { this.state = STATE_GAP; meashl = false; }
        break;
      case STATE_GAP:
        ++this.numg;
        if (mag > threshold + hysteresis) { this.numg = 0; this.state = STATE_PULSE; meashl = true; } else meashl = false;
        break;
    }
    if (meashl === this.currentHiLow && this.currentDurationNs < 30_000_000) this.currentDurationNs += this.nsPerSamp;
    else {
      if (this.currentDurationNs >= 30_000_000) this.state = STATE_IDLE;
      this.feed(this.currentHiLow, Math.floor(this.currentDurationNs / 1000));
      this.currentDurationNs = this.nsPerSamp;
      this.currentHiLow = meashl;
    }
  }

  /**
   * One decimated sample through the FSK slicer: while a carrier is up (the OOK tracker says so), the smoothed
   * phase step above its running middle is "high"; pulses of each level go to the FM decoders.
   */
  private fmSample(ci: number, cq: number): void {
    const d = Math.atan2(ci * this.fmPrevQ - cq * this.fmPrevI, ci * this.fmPrevI + cq * this.fmPrevQ);
    this.fmPrevI = ci; this.fmPrevQ = cq;
    this.fmLP += 0.5 * (d - this.fmLP);
    const present = this.state !== STATE_IDLE;
    let level = false;
    if (present) {
      if (!this.fmWasPresent) this.fmMid = this.fmLP;
      this.fmMid += 0.01 * (this.fmLP - this.fmMid);
      level = this.fmLP > this.fmMid;
    }
    this.fmWasPresent = present;
    if (level === this.fmLevel && this.fmDurNs < 30_000_000) this.fmDurNs += this.nsPerSamp;
    else {
      const us = Math.floor(this.fmDurNs / 1000);
      const lv = this.fmLevel;
      for (const p of this.pirFm) p.feed(lv, us);
      for (const p of this.pirFmInv) p.feed(!lv, us);
      this.fmDurNs = this.nsPerSamp;
      this.fmLevel = level;
    }
  }

  /** A ProtoPirate decode, shown once per frame (the same key within 1.2 s is a repeat). */
  private onPirate(h: PPHit): void {
    const key = `pp:${h.name}:${h.key}`;
    const now = performance.now();
    if (now - (this.seen.get(key) ?? -1e9) < 1200) return;
    this.seen.set(key, now);
    if (this.seen.size > 500) this.seen.clear();
    let line = `CAR ${h.name}`;
    if (h.serial !== null) line += `  serial ${hex(h.serial, 1)}`;
    if (h.btn) line += `  btn ${h.btn}`;
    if (h.cnt !== null) line += `  cnt ${h.cnt}`;
    line += `  key ${h.key} (${h.bits} bits)`;
    for (const f of h.fields) line += `  ${f.name.toLowerCase()} ${f.value}`;
    this.emit({ type: 'packet', line });
  }

  private feed(level: boolean, durationUs: number): void {
    for (const p of this.protos) {
      const on = p.family === Fam.WEATHER ? this.weather : p.family === Fam.REMOTE ? this.remotes : this.cars;
      if (on) p.feed(level, durationUs);
    }
    if (this.cars) for (const p of this.pirAm) p.feed(level, durationUs);
  }

  private onHit(p: FProto): void {
    const key = `${p.family}:${p.sensorType}:${p.decodeData}:${p.decodeData2}`;
    const now = performance.now();
    if (now - (this.seen.get(key) ?? -1e9) < 1200) return;
    this.seen.set(key, now);
    if (this.seen.size > 500) this.seen.clear();
    let line: string;
    if (p.family === Fam.WEATHER) {
      const w = parseWeather(p.sensorType, p.decodeData);
      line = `WX ${w.name.padEnd(20)} id ${w.id}`;
      if (w.channel !== null) line += `  ch ${w.channel}`;
      if (w.temp !== null) line += `  ${w.temp.toFixed(1)}°C / ${(w.temp * 9 / 5 + 32).toFixed(1)}°F`;
      if (w.humidity !== null) line += `  ${w.humidity}%`;
      if (w.batteryLow !== null) line += w.batteryLow ? '  batt LOW' : '  batt OK';
    } else if (p.family === Fam.REMOTE) {
      const r = parseRemote(p.sensorType, p.decodeData, p.dataCountBit);
      line = `REMOTE ${r.name.padEnd(16)} key ${hex(p.decodeData)} (${p.dataCountBit} bits)`;
      if (r.serial !== 0n) line += `  serial ${hex(r.serial, 1)}`;
      if (r.btn !== null) line += `  btn ${r.btn}`;
      if (r.cnt !== null) line += `  cnt ${r.cnt}`;
      for (const e of r.extra) line += `  ${e}`;
    } else {
      const c = parseCar(p.sensorType, p.decodeData, p.decodeData2, p.dataCountBit);
      line = `CAR ${c.name.padEnd(12)} serial ${hex(c.serial, 1)}`;
      if (c.btn) line += `  btn ${c.btn}`;
      if (c.cnt !== null) line += `  cnt ${c.cnt}`;
      line += `  data ${hex(p.decodeData, 1)}`; if (p.decodeData2 !== 0n) line += ` ${hex(p.decodeData2, 1)}`;
      for (const e of c.extra) line += `  ${e}`;
    }
    this.emit({ type: 'packet', line });
  }
}
