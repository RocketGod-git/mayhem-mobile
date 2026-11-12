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
import { PulseDetect, PulseKind } from './detect.js';
import { BurstChannels, MAX_CHANNELS, type BurstChannel } from './channels.js';
import { KeyDecoders, type KeyReading } from './keys.js';
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
  /** Bursts being followed right now, and how many have been since the start. */
  channels: number;
  followed: number;
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

/** Everything registered, in protocol order — what the receiver can recognise. */
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
  /** What kind of thing it is: an rtl_433 sensor, a car key, a gate or garage remote, or a weather sensor read by Mayhem's decoders. */
  family: 'sensor' | 'key' | 'remote' | 'weather';
  /** Where it was heard, as an offset from the radio's center in hertz. */
  offsetHz: number;
  /** Frequency shift keyed rather than on-off keyed. */
  fsk: boolean;
}

/** How a reading is named. Devices with an identity keep it; those without are grouped by model alone. */
function keyOf(model: string, d: R433Data): string {
  const id = d.id !== undefined ? String(d.id) : '';
  const ch = d.channel !== undefined ? String(d.channel) : '';
  const sub = d.subtype !== undefined ? String(d.subtype) : '';
  return [model, id, ch, sub].filter(Boolean).join('/');
}

const STATS_MS = 1000;
/** Readings no real device gives: a tire or sensor outside -40..125 °C, or a tire above 100 psi. */
function plausible(d: R433Data): boolean {
  const n = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
  const tc = !isNaN(n(d.temperature_C)) ? n(d.temperature_C) : !isNaN(n(d.temperature_F)) ? (n(d.temperature_F) - 32) * 5 / 9 : NaN;
  const tire = /tpms|tire|tyre|pressure/i.test(`${d.model} ${d.type ?? ''}`);
  if (tire && !isNaN(tc) && (tc < -40 || tc > 125)) return false;
  const psi = !isNaN(n(d.pressure_PSI)) ? n(d.pressure_PSI) : !isNaN(n(d.pressure_kPa)) ? n(d.pressure_kPa) * 0.1450377 : !isNaN(n(d.pressure_bar)) ? n(d.pressure_bar) * 14.50377 : NaN;
  if (tire && !isNaN(psi) && psi > 100) return false;
  return true;
}
/** Car-key decoders whose frames carry too little checking to trust a single one. */
const WEAK_KEYS = new Set(['Honda Static']);

export class R433Processor implements IqProcessor {
  private readonly channels: BurstChannels;
  /** One rtl_433 detector and one set of key decoders per channel slot, reused as bursts come and go. */
  private readonly slots: { pd: PulseDetect; keys: KeyDecoders; pending: { r: KeyReading; hz: number }[]; verified: boolean }[] = [];
  /** Which slot is being read right now. */
  private curSlot = 0;
  /** Milliseconds of radio time since the start, for telling a repeat from a new press. */
  private airMs = 0;
  /** Key, remote and weather readings shown, for the decoded count beside rtl_433's. */
  private keysDecoded = 0;
  /** Weak-check presses heard once, waiting for a second hearing. */
  private readonly unconfirmed = new Map<string, { press: string; at: number }>();
  private radio = new R433();
  private rate = 0;
  private lastStats = 0;
  /** The offset of the channel being read right now, so a reading knows where it was heard. */
  private curHz = 0;
  /** Everything heard since the app was opened, newest reading kept per device. */
  readonly heard = new Map<string, HeardDevice>();
  /** The last reading of each device, so an identical repeat within a second is not reported twice. */
  private readonly lastPayload = new Map<string, { json: string; at: number }>();
  /** When each unidentified shape was last passed to the interface, so a busy band does not redraw constantly. */
  private readonly unknownSeen = new Map<string, number>();
  private readonly sink = (kind: PulseKind, pulses: Parameters<typeof this.radio.run>[1]) => {
    const found = this.radio.run(kind, pulses);
    // The checksumless protocols rtl_433 ships switched off will "decode" a sensor they were never meant for
    // into nonsense — the phantom Jansite reading 132 °C that sits next to the real Renault reading of the very
    // same burst. When a checksum-verified protocol has already claimed this burst, drop those unverified
    // matches rather than listing a device that is not there.
    const verified = found.some(r => !r.dev.disabled);
    if (verified) this.slots[this.curSlot].verified = true;
    // Two checksum-verified protocols can both claim one burst with the same ID and read it differently (two
    // Schrader TPMS formats, 30 psi and 37.5 psi). The protocols run in rtl_433's priority order, so the first
    // one to claim an ID in a burst is the reading kept. And a reading no device could give (a tire at 290 °F)
    // is a misread, whatever its checksum said.
    const ids = new Set<string>();
    for (const res of found) {
      if (verified && res.dev.disabled) continue;
      if (!plausible(res.data)) continue;
      const id = res.data.id !== undefined ? String(res.data.id) : '';
      if (id) { if (ids.has(id)) continue; ids.add(id); }
      this.report(res.dev, res.data, kind);
    }
    if (!found.length) this.reportUnknown(pulses);
  };

  constructor(private readonly emit: Emit) {
    this.channels = new BurstChannels((ch, env, fm, n) => this.onChannel(ch, env, fm, n), (ch) => this.onChannelEnd(ch));
    for (let i = 0; i < MAX_CHANNELS; i++) {
      const slot = { pd: new PulseDetect(250_000), keys: new KeyDecoders((r) => slot.pending.push({ r, hz: this.curHz })), pending: [] as { r: KeyReading; hz: number }[], verified: false };
      this.slots.push(slot);
    }
  }

  reset(rate: number): void {
    this.rate = rate;
    this.channels.reset(rate);
    this.lastStats = 0;
  }

  /** Kept for the interface; every burst in the span is now tuned to on its own, so there is no slice to choose. */
  setSpan(_hz: number): void { /* the whole span is always watched */ }

  /** The span watched: all of it. */
  span(): number { return this.rate; }

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
    this.unconfirmed.clear();
    this.unknownSeen.clear();
  }

  onIq(iq: Int8Array, rate: number): void {
    if (rate !== this.rate) this.reset(rate);
    this.channels.process(iq);
    this.airMs += (iq.length >> 1) / rate * 1000;
    const now = Date.now();
    if (now - this.lastStats >= STATS_MS) {
      this.lastStats = now;
      const lv = this.slots[0].pd.levels();
      const report: R433Report = {
        ...this.radio.stats, devices: this.heard.size, protocols: this.radio.devices.length,
        noise: lv.noise, trigger: lv.trigger, span: this.span(), channels: this.channels.active(), followed: this.channels.opened,
        decoded: this.radio.stats.decoded + this.keysDecoded,
      };
      this.emit({ type: 'r433stats', ...report });
    }
  }

  private onChannel(ch: BurstChannel, env: Int16Array, fm: Int16Array, n: number): void {
    const s = this.slots[ch.slot];
    if (ch.fresh) { s.pd.setSampleRate(ch.rate); s.pd.reset(); s.keys.slicer.reset(ch.rate); s.keys.slicer.flush(); s.keys.reset(); s.pending.length = 0; s.verified = false; }
    this.curHz = ch.hz; this.curSlot = ch.slot;
    s.pd.process(env, fm, n, this.sink);
    s.keys.slicer.process(env, fm, n);
  }

  private onChannelEnd(ch: BurstChannel): void {
    const s = this.slots[ch.slot];
    this.curHz = ch.hz; this.curSlot = ch.slot;
    s.pd.flush(this.sink);
    s.keys.slicer.flush();
    // Keys and remotes carry little or no checksum, so a sensor's burst can read as one by chance. When a
    // checksum-verified sensor claimed this burst, what the key decoders made of it is noise.
    if (!s.verified) for (const k of s.pending) { this.curHz = k.hz; this.reportKey(k.r); }
    s.pending.length = 0; s.verified = false;
  }

  /** A car key, remote or weather sensor read by Mayhem's and ProtoPirate's decoders. */
  private reportKey(r: KeyReading): void {
    // A key with no serial of its own is known by the part of its frame that never changes, when the decoder
    // names one; and one press is known by its rolling code, which stays the same when a key repeats the press
    // on another of its channels (the channel byte changes the rest of the frame).
    const field = (n: string) => r.fields.find(([k]) => k === n)?.[1] ?? '';
    const id = r.id || field('FIXED');
    const press = field('HOP') || field('COUNTER') || r.raw;
    const key = `${r.family}/${r.model}/${id || r.raw}`;
    const now = Date.now();
    // Decoders with little or no integrity check (Honda Static's reversed path never compares its checksum, and
    // fixed-code remotes have none) can read noise as a key. A real fob repeats every press several times, so
    // these are shown only once the same press has been heard twice within a second and a half.
    if (r.family === 'remote' || WEAK_KEYS.has(r.model)) {
      const seen = this.unconfirmed.get(key);
      if (!seen || seen.press !== press || this.airMs - seen.at > 1500) { this.unconfirmed.set(key, { press, at: this.airMs }); if (this.unconfirmed.size > 500) this.unconfirmed.clear(); return; }
    }
    // one press sends the same frame several times: within 1.2 s of radio time it is the same press
    const last = this.lastPayload.get(key);
    if (last && last.json === press && this.airMs - last.at < 1200) return;
    this.lastPayload.set(key, { json: press, at: this.airMs });
    this.keysDecoded++;
    const data: R433Data = { model: r.model };
    if (id) data.id = id;
    for (const [k, v] of r.fields) data[k.toLowerCase().replace(/[^a-z0-9]+/g, '_')] = v;
    data.code = r.raw; data.bits = r.bits;
    const prev = this.heard.get(key);
    const entry: HeardDevice = {
      key, model: r.model, num: 0, what: r.family === 'key' ? 'car key' : r.family === 'remote' ? 'gate or garage remote' : 'weather sensor',
      count: (prev?.count ?? 0) + 1, firstSeen: prev?.firstSeen ?? now, lastSeen: now, data,
      family: r.family, offsetHz: Math.round(this.curHz), fsk: false,
    };
    this.heard.set(key, entry);
    this.emit({ type: 'r433', ...entry });
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
      family: 'sensor',
      offsetHz: Math.round(this.curHz),
      fsk: kind === PulseKind.FSK,
    };
    this.heard.set(key, entry);
    this.emit({ type: 'r433', ...entry });
  }
}
