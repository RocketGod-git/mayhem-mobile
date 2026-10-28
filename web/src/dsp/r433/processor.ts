/**
 * The receiver: samples in, readings out.
 *
 * Everything below this is faithful rtl_433; everything above it is the app. This is the join — it turns the
 * radio's samples into the two streams the pulse detector wants, hands each burst to every protocol at once,
 * and keeps a table of what has been heard so the interface can show devices rather than a scrolling log.
 *
 * Nothing here is tuned to a channel: whatever slice of spectrum is being listened across is watched all at
 * once, so every device inside it is heard without being asked for — which is the point, since you do not know
 * what is out there until it transmits. How wide that slice is trades reach against sensitivity, and is the
 * single most useful thing to change when nothing is decoding.
 */

import type { Emit, IqProcessor } from '../core.js';
import { Baseband } from './baseband.js';
import { PulseDetect, PulseKind } from './detect.js';
import { R433 } from './runner.js';
import { REGISTRY, type R433Data, type RDevice } from './device.js';
import { describeBurst, shapeSummary, type BurstShape } from './analyze.js';
import type { R433Stats } from './runner.js';
import './devices/index.js';

/** The once-a-second summary line: how the receiver is doing, not what it heard. */
export interface R433Report extends R433Stats {
  /** Distinct devices heard since the app was opened. */
  devices: number;
  /** How many protocols are being tried against each burst. */
  protocols: number;
  /** The noise floor the detector has settled on, in magnitude units (full scale 16384). */
  noise: number;
  /** The magnitude a burst must exceed to be taken as a carrier. */
  trigger: number;
  /** How wide a slice of the span is actually being listened across, in hertz. */
  span: number;
}

/** One line about a protocol, for the list the app shows of everything it can hear. */
export interface R433Protocol {
  num: number;
  name: string;
  what: string;
  /** How the bits are carried, in words rather than a number. */
  coding: string;
  /** Which bands this is normally found in, in megahertz. */
  bands: number[];
  /**
   * rtl_433 ships this one switched off, because it has no usable checksum and will sometimes claim another
   * maker's transmission. It runs here regardless; this only marks a reading from it as worth a second look.
   */
  doubtful: boolean;
}

/** Modulation numbers read back as the thing they describe. */
const CODING: Record<number, string> = {
  3: 'Manchester', 4: 'level per bit', 5: 'pulse position', 6: 'pulse width',
  8: 'level per bit, raw', 9: 'differential Manchester', 10: 'pulse width, Oregon v1',
  11: 'level per bit, clocked', 12: 'NRZ-S', 13: 'return to zero, inverted',
  16: 'frequency shift, level per bit', 17: 'frequency shift, pulse width',
  18: 'frequency shift, Manchester',
};

/** Everything registered, in protocol order — what the receiver can recognize. */
export function protocolList(): R433Protocol[] {
  return REGISTRY.map(d => ({
    num: d.num,
    name: d.name,
    what: d.what ?? '',
    coding: CODING[d.modulation] ?? String(d.modulation),
    bands: (d.bands ?? []).map(hz => hz / 1e6),
    doubtful: !!d.disabled,
  })).sort((a, b) => a.num - b.num);
}

/** What we remember about one device we have heard. */
export interface HeardDevice {
  key: string;
  model: string;
  /**
   * rtl_433's protocol number, so it can be looked up against that project's documentation. Zero marks a burst
   * no protocol claimed, which is described from its timings instead - see `shape`.
   */
  num: number;
  /** Which decoder produced it, for the interface's explanation of what the thing is. */
  what: string;
  count: number;
  firstSeen: number;
  lastSeen: number;
  data: R433Data;
  /**
   * Present only on unidentified bursts: the measurements taken from the transmission itself, since there is no
   * decoder output to show. A reading and a shape never both appear.
   */
  shape?: BurstShape;
}

/** How a reading is named. Devices with an identity keep it; those without are grouped by model alone. */
function keyOf(model: string, d: R433Data): string {
  const id = d.id !== undefined ? String(d.id) : '';
  const ch = d.channel !== undefined ? String(d.channel) : '';
  const sub = d.subtype !== undefined ? String(d.subtype) : '';
  return [model, id, ch, sub].filter(Boolean).join('/');
}

const STATS_MS = 1000;

export class R433Processor implements IqProcessor {
  private readonly baseband = new Baseband();
  private detect = new PulseDetect(2_000_000);
  private radio = new R433();
  private rate = 0;
  private lastStats = 0;
  /** Everything heard since the app was opened, newest reading kept per device. */
  readonly heard = new Map<string, HeardDevice>();
  /** The last reading of each device, so an identical repeat within a second is not reported twice. */
  private readonly lastPayload = new Map<string, { json: string; at: number }>();
  /** When each unidentified shape was last passed to the interface, so a busy band does not redraw constantly. */
  private readonly unknownSeen = new Map<string, number>();

  /**
   * How wide a slice of the sampled span to actually listen across, in hertz.
   *
   * Narrower hears weaker devices — the envelope detector takes in the noise of everything it is given, so
   * halving the span takes three decibels off the noise without touching the wanted signal. Wider hears devices
   * that sit off the dial. A quarter of a megahertz is what rtl_433 asks its own radio for, and covers
   * essentially everything that calls itself a 433.92 device.
   */
  private wantSpan = 250_000;

  constructor(private readonly emit: Emit) {}

  reset(rate: number): void {
    this.rate = rate;
    this.baseband.reset();
    // Whole powers of two only, so the averaging stays exact and the decimated rate stays a round number.
    let decim = 1;
    while (rate / (decim * 2) >= this.wantSpan) decim *= 2;
    this.baseband.decim = decim;
    this.detect = new PulseDetect(Math.round(rate / decim));
    this.lastStats = 0;
  }

  /** Choose how wide to listen. Takes effect on the next block of samples. */
  setSpan(hz: number): void {
    this.wantSpan = hz;
    if (this.rate) this.reset(this.rate);
  }

  /** The span actually in use, which is the sample rate divided by a whole power of two. */
  span(): number {
    return this.rate ? Math.round(this.rate / (this.baseband.decim || 1)) : 0;
  }

  /**
   * Narrow the protocols in use. An empty list means everything registered, which is the default: every
   * protocol runs against every burst, including the ones rtl_433 itself ships switched off.
   */
  setProtocols(nums: number[] | null): void {
    const devices = nums && nums.length
      ? REGISTRY.filter(d => nums.includes(d.num))
      : REGISTRY.slice();
    this.radio = new R433(devices);
  }

  /** Forget everything heard, without disturbing the receiver. */
  clear(): void {
    this.heard.clear();
    this.lastPayload.clear();
    this.unknownSeen.clear();
  }

  onIq(iq: Int8Array, rate: number): void {
    if (rate !== this.rate) this.reset(rate);
    const { env, fm, n } = this.baseband.process(iq);

    const sink = (kind: PulseKind, pulses: Parameters<typeof this.radio.run>[1]) => {
      const found = this.radio.run(kind, pulses);
      // The checksumless protocols rtl_433 ships switched off will "decode" a sensor they were never meant for
      // into nonsense — the phantom Jansite reading 132 °C that sits next to the real Renault reading of the very
      // same burst. When a checksum-verified protocol has already claimed this burst, drop those unverified
      // matches rather than listing a device that is not there. A lone unverified match still shows (flagged),
      // since with nothing to compare it against it might be the real thing.
      const verified = found.some(r => !r.dev.disabled);
      for (const res of found) { if (verified && res.dev.disabled) continue; this.report(res.dev, res.data, kind); }
      if (!found.length) this.reportUnknown(pulses);
    };
    this.detect.process(env, fm, n, sink);

    const now = Date.now();
    if (now - this.lastStats >= STATS_MS) {
      this.lastStats = now;
      const lv = this.detect.levels();
      const report: R433Report = {
        ...this.radio.stats, devices: this.heard.size, protocols: this.radio.devices.length,
        noise: lv.noise, trigger: lv.trigger, span: this.span(),
      };
      this.emit({ type: 'r433stats', ...report });
    }
  }

  /**
   * A burst that no protocol recognized, reported for what it measurably is.
   *
   * Most of these are real devices this port does not cover yet, and a few are interference that happened to
   * key hard enough to look deliberate. Both are worth showing: the point of a receiver like this is to say what
   * is on the air, and "something transmits here on this timing" is a true and useful thing to say even when the
   * meaning is unknown. Anything under eight marks is left out - that is too short to have a shape at all, and
   * is where the noise lives.
   */
  private reportUnknown(p: Parameters<typeof this.radio.run>[1]): void {
    if (p.numPulses < 8) return;
    const shape = describeBurst(p);
    const key = `? ${shape.key}`;
    const now = Date.now();

    // Unidentified bursts are kept OUT of the device list: most are fragments of a signal decoded elsewhere (the
    // OOK slicers catching a whiff of an FSK packet) or one-off interference, and they only bury the real readings.
    // They are logged to the browser console instead — once a second per shape so a busy band does not flood it —
    // where they can be copied for a closer look without cluttering the screen.
    const seen = this.unknownSeen.get(key) ?? 0;
    if (now - seen < 1000) return;
    this.unknownSeen.set(key, now);
    console.log(`[r433] unidentified · ${shape.fsk ? 'FSK' : 'OOK'} · ${shapeSummary(shape)} · ${shape.coding || 'coding unsettled'}`, shape);
  }

  private report(dev: RDevice, data: R433Data, kind: PulseKind): void {
    const key = keyOf(data.model, data);
    const now = Date.now();

    // A burst holds several repeats of the same message, and each can decode. Report the reading once.
    const json = JSON.stringify(data);
    const last = this.lastPayload.get(key);
    if (last && last.json === json && now - last.at < 1000) return;
    this.lastPayload.set(key, { json, at: now });

    // The protocols rtl_433 ships switched off have no usable checksum and misfire on other traffic. A lone one
    // (nothing verified claimed its burst) is unproven, so it stays out of the device list and goes to the console
    // for inspection rather than posing as a real device.
    if (dev.disabled) { console.log(`[r433] unverified ${data.model} (protocol ${dev.num})`, data); return; }

    const prev = this.heard.get(key);
    const entry: HeardDevice = {
      key,
      model: data.model,
      num: dev.num,
      what: dev.what ?? dev.name,
      count: (prev?.count ?? 0) + 1,
      firstSeen: prev?.firstSeen ?? now,
      lastSeen: now,
      data,
    };
    this.heard.set(key, entry);
    this.emit({ type: 'r433', ...entry, fsk: kind === PulseKind.FSK });
  }
}
