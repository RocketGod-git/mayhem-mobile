/**
 * The LoRa app's model. Port of core/lora/LoraHub.swift: each frame the scanner hears is read as Meshtastic, MeshCore
 * or LoRaWAN (the sync word says which network, the packet's own structure and checks confirm it), or kept as raw
 * LoRa; the nodes it names get a card each, with everything they have said about themselves.
 *
 * It is the IqProcessor the DSP worker runs for the LoRa app. It publishes through `emit`:
 *  - `{ type: 'packet', line }` for every frame (the PacketLog line), like the other decoders;
 *  - `{ type: 'lora', ... }` (LoraSnapshot below), at most 4 times a second while something changed.
 */
import type { Emit, IqProcessor } from '../core.js';
import * as MC from './meshcore.js';
import * as LW from './lorawan.js';
import * as MT from './meshtastic.js';
import { fixed, hex2, hex8, hexBytes } from './meshtastic.js';
import { roundAway, type LoraFrame } from './phy.js';
import { BANDS, NARROW_SHIFT, NARROW_TILES, homeBand, type LoraBand } from './plan.js';
import { LoraScanner, type LoraChannelState, type LoraHeard } from './scanner.js';

export interface MeshField { name: string; value: string }

export interface LoraNode {
  key: string;
  proto: string;
  label: string;
  name: string | null;
  kind: string;
  lat: number | null; lon: number | null;
  firstMs: number; lastMs: number;
  packets: number;
  /** SNR of the recent packets (dB, rounded), oldest first, 24 at most. */
  snr: number[];
  fields: MeshField[];
  last: string;
  hz: number;
  modem: string;
  texts: string[];
}

export interface LoraEvent {
  id: number;
  ms: number;
  proto: string;
  kind: string;
  from: string | null;
  nodeKey: string | null;
  text: string | null;
  channel: string | null;
  line: string;
  fields: MeshField[];
}

/** The `{ type: 'lora' }` message. Plain JSON-serializable data. */
export interface LoraSnapshot {
  type: 'lora';
  /** Every node heard, in first-heard order (the screen sorts by lastMs). */
  nodes: LoraNode[];
  /** The text messages (events with text), newest first. */
  messages: LoraEvent[];
  /** Bursts that got a channel of their own, frames decoded. */
  bursts: number;
  frames: number;
  /** The span: its rate, its center (as set with setCenter), and whether it is wide (>= 10 Msps: band tiles). */
  rate: number;
  centerHz: number;
  wide: boolean;
  /** The wide-span band tiles, and which one is tuned (-1: none). */
  bands: LoraBand[];
  band: number;
  /** The 2 MHz span's tiles: tune to hz + shift. */
  narrowTiles: { title: string; sub: string; hz: number }[];
  narrowShift: number;
  /** The band tile for the browser's region setting. */
  home: number;
  /** The known channels inside the span, with their activity; channels with receivers running now. */
  channels: LoraChannelState[];
  open: number;
  /** Processing time over air time, smoothed (1 = just keeping up). */
  busy: number;
}

const put = (n: LoraNode, name: string, value: string): void => {
  const i = n.fields.findIndex(f => f.name === name);
  if (i >= 0) n.fields[i] = { name, value }; else n.fields.push({ name, value });
};
const F = (name: string, value: string): MeshField => ({ name, value });
const signed = (v: number, d: number): string => (v >= 0 ? '+' : '') + fixed(v, d);
const ifEmpty = (s: string, f: () => string): string => (s.length === 0 ? f() : s);

export class LoraHub implements IqProcessor {
  readonly scanner = new LoraScanner();
  /** Every frame heard, for tests and tools. */
  onHeard: ((h: LoraHeard, e: LoraEvent) => void) | null = null;
  private nodes: LoraNode[] = [];
  private events: LoraEvent[] = [];
  private bursts = 0;
  private byKey = new Map<string, LoraNode>();
  private order: string[] = [];
  private count = 0;
  /** Meshtastic packets already shown, by sender and packet id, and when: a repeater's copy of a packet (its hop
   *  fields rewritten) is the same packet and is counted, not shown again. */
  private seenPackets = new Map<string, number>();
  private centerHz = 0;
  private rate = 0;
  private dirty = true;
  private lastEmit = 0;
  private lastStatus = 0;
  /** Snapshots at most this often (ms). */
  static readonly SNAPSHOT_MS = 250;

  constructor(private readonly emit: Emit) {
    this.scanner.centerOf = () => this.centerHz;
    this.scanner.onHeard = h => this.heard(h);
    this.scanner.onBurst = () => { this.bursts++; this.dirty = true; };
  }

  // ---- commands (from the worker's onmessage) ----

  /** The radio's center frequency: the known channels are placed against it. Call on every confirmed tune. */
  setCenter(hz: number): void { if (hz !== this.centerHz) { this.centerHz = hz; this.dirty = true; } }

  /** CLEAR on the screen. */
  clear(): void {
    this.byKey.clear(); this.order = []; this.count = 0; this.nodes = []; this.events = []; this.bursts = 0;
    this.dirty = true; this.flush();
  }

  /** Send the snapshot now (e.g. right after the screen opens). */
  flush(): void { this.lastEmit = Date.now(); this.dirty = false; this.emit(this.snapshot() as unknown as Record<string, unknown>); }

  /** Where to tune for a band tile: the band's center at 20 Msps, or its main channel + 300 kHz at 2 Msps. */
  static tuneFor(band: number, wide: boolean): { centerHz: number; rate: number } {
    const b = BANDS[band] ?? homeBand();
    return wide ? { centerHz: b.center, rate: LoraScanner.RATE } : { centerHz: b.narrow + NARROW_SHIFT, rate: LoraScanner.NARROW_RATE };
  }

  // ---- IqProcessor ----

  reset(rate: number): void { this.rate = rate; this.scanner.reset(rate); this.dirty = true; }

  onIq(iq: Int8Array, rate: number): void {
    this.rate = rate;
    this.scanner.onIq(iq, rate);
    const t = Date.now();
    // channel activity and load change all the time: they count once a second
    if (t - this.lastStatus >= 1000) { this.lastStatus = t; this.dirty = true; }
    if (this.dirty && t - this.lastEmit >= LoraHub.SNAPSHOT_MS) this.flush();
  }

  snapshot(): LoraSnapshot {
    const band = BANDS.findIndex(b => b.center === this.centerHz);
    return {
      type: 'lora', nodes: this.nodes, messages: this.events.filter(e => e.text !== null),
      bursts: this.bursts, frames: this.count, rate: this.rate, centerHz: this.centerHz, wide: this.rate >= 10_000_000,
      bands: BANDS, band, narrowTiles: NARROW_TILES, narrowShift: NARROW_SHIFT, home: BANDS.indexOf(homeBand()),
      channels: this.scanner.channelStates(), open: this.scanner.openChannels, busy: this.scanner.busy,
    };
  }

  /** For tests and tools: the hub's state, as the Swift exposes it. */
  get nodeList(): LoraNode[] { return this.nodes; }
  get eventList(): LoraEvent[] { return this.events; }
  get burstCount(): number { return this.bursts; }
  get frameCount(): number { return this.count; }

  static hex(b: ArrayLike<number>): string { return hexBytes(b); }
  static mhz(hz: number): string { return `${fixed(hz / 1e6, 4)} MHz`; }
  static bwName(bw: number): string { return bw === 62_500 ? '62.5 kHz' : `${Math.trunc(bw / 1000)} kHz`; }

  /** The network a sync word names, from its high nibble (the first sync symbol is that nibble times 8). */
  static syncNibble(f: LoraFrame): number { return Math.trunc(((f.sync[0] ?? 0) + 4) / 8) & 0x0f; }

  heard(h: LoraHeard): void { this.take(h); }

  private take(h: LoraHeard): void {
    const f = h.frame;
    const ms = h.time;
    const nib = LoraHub.syncNibble(f);
    const modem = `SF${f.sf} · ${LoraHub.bwName(f.bw)} · CR 4/${4 + f.cr}`;
    const common: MeshField[] = [F('FREQUENCY', LoraHub.mhz(h.hz)), F('MODEM', modem + (h.inverted ? ' · downlink (inverted)' : '')),
      F('SNR', `${signed(f.snrDb, 1)} dB`), F('LENGTH', `${f.payload.length} bytes`)];
    common.push(F('CRC', f.crcOk === null ? 'none sent' : f.crcOk ? 'ok' : 'failed'));
    let proto = 'LoRa', kind = 'FRAME';
    let from: string | null = null, key: string | null = null, text: string | null = null, chan: string | null = null;
    let fields: MeshField[] = [];
    const good = f.crcOk !== false;
    let node: ((n: LoraNode) => void) | null = null;

    const mt = good ? MT.parse(f.payload) : null;
    const mtOk = mt !== null && (mt.portnum !== null || nib === 2);
    const mc = good && !mtOk ? MC.parse(f.payload) : null;
    const mcOk = mc !== null && (nib === 1 || mc.channel !== null || (mc.type === 4 && mc.name !== null));
    const lw = good && !mtOk && !mcOk && nib === 3 ? LW.parse(f.payload) : null;

    if (mtOk && mt) {
      const pk = `${mt.from}/${mt.id}`;
      for (const [k, v] of this.seenPackets) if (!(ms - v < 600_000)) this.seenPackets.delete(k);
      if (this.seenPackets.has(pk)) {
        // a repeat: the node's card keeps its count of copies heard, nothing else changes
        const nk = 'MT/' + MT.nodeName(mt.from);
        const n = this.byKey.get(nk);
        if (n) {
          const before = parseInt(n.fields.find(x => x.name === 'REPEATS HEARD')?.value ?? '0', 10) || 0;
          put(n, 'REPEATS HEARD', String(before + 1));
          this.publishNodes();
        }
        return;
      }
      this.seenPackets.set(pk, ms);
      proto = 'Meshtastic'; kind = MT.portName(mt);
      const id = MT.nodeName(mt.from);
      from = mt.shortName ?? id; key = 'MT/' + id; text = mt.text;
      chan = mt.fields.find(x => x[0] === 'CHANNEL')?.[1] ?? null;
      fields = [F('FROM', id), F('TO', MT.nodeName(mt.dest)), F('PACKET ID', hex8(mt.id)),
        F('HOPS', mt.hopStart > 0 ? `${mt.hopStart - mt.hopLimit} of ${mt.hopStart} used` : `limit ${mt.hopLimit}`)];
      if (mt.relayNode !== 0) fields.push(F('RELAYED BY', `…${hex2(mt.relayNode)}`));
      if (mt.wantAck) fields.push(F('WANTS ACK', 'yes'));
      if (mt.viaMqtt) fields.push(F('VIA MQTT', 'yes'));
      if (mt.portnum === null) fields.push(F('CONTENT', `encrypted, channel hash ${hex2(mt.channelHash)}`));
      fields.push(...mt.fields.map(([a, b]) => F(a, b)));
      node = n => {
        n.kind = ifEmpty([mt.hwModel, mt.role].filter((x): x is string => x !== null).join(' · '), () => ifEmpty(n.kind, () => 'MESHTASTIC NODE'));
        if (mt.shortName !== null) n.label = mt.shortName;
        if (mt.longName !== null) n.name = mt.longName;
        if (mt.lat !== null && mt.lon !== null) { n.lat = mt.lat; n.lon = mt.lon; }
        for (const [k, v] of mt.fields) if (k !== 'TEXT' && k !== 'REPLY TO') put(n, k, v);
        if (mt.portnum === null) put(n, 'CHANNEL', `private (hash ${hex2(mt.channelHash)})`);
      };
    } else if (mcOk && mc) {
      proto = 'MeshCore'; kind = mc.typeName; text = mc.text; chan = mc.channel;
      fields = mc.fields.map(([a, b]) => F(a, b));
      if (mc.nodeKey) {
        key = 'MC/' + hexBytes(mc.nodeKey, 0, 6);
        from = mc.name ?? hexBytes(mc.nodeKey, 0, 2);
      } else if (mc.name !== null) {
        from = mc.name;
        key = [...this.byKey.values()].find(x => x.proto === 'MeshCore' && x.name === mc.name)?.key ?? null;
      }
      node = n => {
        if (mc.name !== null) { n.name = mc.name; n.label = Array.from(mc.name).slice(0, 10).join(''); }
        if (mc.nodeType !== null) n.kind = mc.nodeType.toUpperCase();
        if (n.kind.length === 0) n.kind = 'MESHCORE NODE';
        if (mc.lat !== null && mc.lon !== null) { n.lat = mc.lat; n.lon = mc.lon; }
        for (const [k, v] of mc.fields) if (k !== 'TEXT' && k !== 'ROUTE' && k !== 'PATH' && k !== 'SENT') put(n, k, v);
      };
    } else if (lw) {
      proto = 'LoRaWAN'; kind = lw.typeName;
      fields = lw.fields.map(([a, b]) => F(a, b));
      if (lw.devAddr !== null) { const a = lw.devAddr.toString(16).toUpperCase().padStart(8, '0'); key = `LW/${a}`; from = a; }
      else if (lw.devEui !== null) { const e = lw.devEui.toString(16).toUpperCase().padStart(16, '0'); key = `LW/${e}`; from = e; }
      node = n => {
        n.kind = lw.uplink ? 'END DEVICE' : 'FROM GATEWAY';
        for (const [k, v] of lw.fields) if (k !== 'MIC') put(n, k, v);
      };
    } else {
      kind = good ? 'RAW FRAME' : 'CRC FAILED';
      fields = [F('SYNC', `word 0x${nib.toString(16).toUpperCase()}? (symbols ${f.sync[0] ?? 0}, ${f.sync.length > 1 ? f.sync[1] : 0})`),
        F('PAYLOAD', hexBytes(f.payload, 0, 64) + (f.payload.length > 64 ? '…' : ''))];
    }
    fields.push(...common);
    this.count++;
    const t = LoraHub.clock(ms);
    const who = from !== null ? ` ${from}` : '';
    const what = text !== null ? ` “${text}”` : '';
    const line = `${t} ${proto.toUpperCase()}${who} ${kind}${what} · ${fixed(h.hz / 1e6, 3)} SF${f.sf}/${Math.trunc(f.bw / 1000)}k ${signed(f.snrDb, 0)} dB`;
    const ev: LoraEvent = { id: this.count, ms, proto, kind, from, nodeKey: key, text, channel: chan, line, fields };
    this.emit({ type: 'packet', line });
    this.events.unshift(ev);
    if (this.events.length > 400) this.events.length = 400;
    this.dirty = true;

    if (key !== null && node) {
      let n = this.byKey.get(key);
      if (!n) {
        n = { key, proto, label: from ?? key, name: null, kind: '', lat: null, lon: null, firstMs: ms, lastMs: ms, packets: 0, snr: [], fields: [], last: '', hz: 0, modem: '', texts: [] };
        this.byKey.set(key, n); this.order.push(key);
      }
      n.lastMs = ms; n.packets++;
      n.snr.push(roundAway(f.snrDb)); if (n.snr.length > 24) n.snr.shift();
      n.hz = h.hz; n.modem = modem;
      n.last = `${kind}${what}`;
      if (text !== null) { n.texts.push(text); if (n.texts.length > 20) n.texts.shift(); }
      node(n);
      this.publishNodes();
    }
    this.onHeard?.(h, ev);
  }

  private publishNodes(): void {
    // a fresh array of fresh node objects, so a snapshot already handed out never changes under its reader
    this.nodes = this.order.map(k => this.byKey.get(k)).filter((n): n is LoraNode => n !== undefined)
      .map(n => ({ ...n, snr: n.snr.slice(), fields: n.fields.slice(), texts: n.texts.slice() }));
    this.dirty = true;
  }

  static clock(ms: number): string {
    const d = new Date(ms), p = (v: number): string => String(v).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }
}
