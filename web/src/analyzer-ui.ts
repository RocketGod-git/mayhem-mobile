/**
 * The Analyzer screen: the list of captured signals, and for the one opened a full-screen view of it: its waveform
 * four ways (amplitude, frequency, I and Q, spectrogram) with each bit marked under it, its bits as text linked
 * both ways to the trace, its demodulation (worked out, or set by hand), a histogram of its pulse lengths, and its
 * repeats lined up bit by bit with named fields, a counter and checksum finder, and saved protocols.
 *
 * The capture runs in the worker (`dsp/analyzer/capture.ts`); everything here reads what it sends. Kept out of
 * main.ts so the screen can be read on its own; main.ts supplies the shell around it through `Host`.
 * Twin of the Android ui/AnalyzerScreen.kt and the iPad/Mac App/ui/AnalyzerScreen.swift.
 */

import type { Scope, ScopeMark } from './scope.js';
import { analyze, carrierOf, noiseOf, bitsToAscii, bitsToHex, pulsesUs, CODINGS, MODS, type Analysis, type Coding, type Mod, type Overrides } from './dsp/analyzer/demod.js';
import { align, similar, type Alignment } from './dsp/analyzer/align.js';
import { decodeBundle, encodeBundle, exportName, freqFromName, toCs8, toCu8, toSub } from './dsp/analyzer/files.js';
import { checkHolds, dataStart, fieldValue, recognize, suggest, FIELD_KINDS, type CheckFound, type Field, type FieldKind, type Protocol } from './dsp/analyzer/fields.js';
import { NO_FILTER, passes, type Burst, type CaptureFilter } from './dsp/analyzer/capture.js';
import { groupPresses, sameFrame, type Transmission } from './dsp/analyzer/group.js';
import { store, type StoredBurst } from './analyzer-store.js';
import { classCsv, clockDrift, frameSegments, framesCsv, levels, pulseCsv, pulseTable, samplesCsv, selectionCsv, symbolFit, type FrameSeg, type Levels, type PulseClass, type PulseTable } from './dsp/analyzer/measure.js';
import { fmtTime, innerMask, paintHistogram, paintMini, paintTrace, valueAt, type View } from './analyzer-paint.js';

/** What the screen needs from the app around it. */
export interface Host {
  /** The radio's center now, Hz, and its sample rate. */
  center(): number;
  rate(): number;
  /** Send to the DSP worker. */
  post(msg: Record<string, unknown>, transfer?: Transferable[]): void;
  /** Whether the Analyzer is the app on screen. */
  showing(): boolean;
  log(line: string): void;
  /** The app's waterfall, for marking bursts on it. */
  scope(): Scope | null;
  /** Hand a Flipper .sub to the Transmit app's replay, tuned to `hz` (Transmit's own safety prompt still applies). */
  sendToTx(sub: string, hz: number, fsk: boolean): void;
}

/** A captured burst as the screen keeps it. */
export interface AnBurst extends Burst {
  /** The radio's center when it was heard (or the file's), Hz; 0 when a file did not say. */
  center: number;
  auto: Analysis;
  /** The longest frame's bits, for the card and for comparing. */
  best: string;
  name: string;
  star: boolean;
  note: string;
  over: Overrides;
  /** When it ended on this page's clock (performance.now()), for its mark on the waterfall; 0 for files and restored ones. */
  seenAt: number;
  /** The saved protocol it matched, and where that protocol's data starts in `best`. */
  proto: { protocol: Protocol; start: number } | null;
}

type Tool = 'select' | 'measure' | 'pan';
const VIEW_LABEL: Record<View, string> = { amp: 'AMPLITUDE', freq: 'FREQUENCY', iq: 'I/Q', spec: 'SPECTROGRAM', eye: 'EYE', const: 'CONSTELLATION' };
/** The same, for a phone's width. */
const VIEW_SHORT: Record<View, string> = { amp: 'AMP', freq: 'FREQ', iq: 'I/Q', spec: 'SPEC', eye: 'EYE', const: 'I×Q' };
/** One press: its bursts, kept in time order. */
type Tx = Transmission & { members: AnBurst[] };
/** A decoder's reading without its family ("car key: Land Rover FSK A824" → "Land Rover FSK A824"). */
const shortLabel = (l: string) => l.replace(/^(car key|remote|weather): /, '');
/** Waterfall boxes fade out over this long after their burst. */
const MARK_FADE_MS = 30_000;
type Fmt = 'bits' | 'hex' | 'ascii';

/** Bursts kept: the oldest unstarred go first. */
const MAX_KEPT = 200;
/** Field colors, by kind. */
const KIND_COLOR: Record<FieldKind, string> = { preamble: '#8d97ab', sync: '#4c8dff', id: '#3fd07a', counter: '#ffaf00', crc: '#ff5d5d', data: '#b48cff' };
const MOD_COLOR: Record<Mod, string> = { OOK: '#ffb020', ASK: '#b48cff', FSK: '#3fd0c9' };

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const two = (n: number) => String(n).padStart(2, '0');
const clock = (t: number) => { const d = new Date(t); return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`; };
const mhz = (hz: number) => `${(hz / 1e6).toFixed(3)} MHz`;
const CODING_LABEL: Record<Coding, string> = { NRZ: 'NRZ', Manchester: 'MANCH', PWM: 'PWM', PPM: 'PPM' };
const rateLabel = (bps: number) => (bps >= 1000 ? `${(bps / 1000).toFixed(2)} kbit/s` : `${bps.toFixed(0)} bit/s`);

export class AnalyzerUi {
  readonly bursts: AnBurst[] = [];
  protocols: Protocol[] = [];
  filter: CaptureFilter = { ...NO_FILTER };
  private filtered = 0;
  private lastId = 0;
  private sel = 0;
  /** The full-screen view is open on `sel`. */
  private opened = false;
  private view: View = 'amp';
  private fmt: Fmt = 'hex';
  private zoom: [number, number] | null = null;
  private pick: [number, number] | null = null;
  /** The bits under the pointer: frame, first bit, one past the last. */
  private hl: { f: number; b0: number; b1: number } | null = null;
  private selOnly = false;
  /** What a drag on the trace does, the A/B cursors (samples), the pointer, and the trace's switches. */
  private tool: Tool = 'select';
  private cursors: [number | null, number | null] = [null, null];
  private hover: { x: number; y: number } | null = null;
  private yz: Record<View, number> = { amp: 1, freq: 1, iq: 1, spec: 1, eye: 1, const: 1 };
  private samplesAxis = false;
  private showDur = false;
  private showClock = false;
  /** Zoom history: each window shown for a moment (null: the burst itself). */
  private hist: ([number, number] | null)[] = [null];
  private histAt = 0;
  private histTimer = 0;
  /** The panels open in the burst view: all of them on a wide screen, only the demodulation on a phone. */
  private readonly openSec = new Set<string>(window.innerWidth > 700 ? ['demod', 'pulses', 'frames', 'levels'] : ['demod']);
  private readonly innerCache = new Map<number, Uint8Array>();
  private ptCache: { a: Analysis; t: PulseTable } | null = null;
  private readCache: { key: string; a: Analysis } | null = null;
  private comparing = false;
  /** The transmission open in the full-screen view (its first burst's id), and whether one of its frames is open in it. */
  private txOpen = 0;
  private txBurst = false;
  /** COMPARE lines up this transmission's frames; 0: every burst that reads alike. */
  private cmpTx = 0;
  private starredOnly = false;
  private showFilter = false;
  private readonly left = new Set<number>();
  /** COMPARE: the fields being worked on, the check found, and the columns dragged out for a new field. */
  private fields: Field[] = [];
  private check: CheckFound | null = null;
  private colPick: [number, number] | null = null;
  private showProtocols = false;
  capturing = true;
  private stats: { channels: number; followed: number; captured: number; span: number } | null = null;
  private pending = 0;
  private root: HTMLElement | null = null;
  private clearArmed = 0;
  private marksTimer = 0;

  constructor(private readonly host: Host) { void this.restore(); }

  // ---- keeping things between visits --------------------------------------------------------------------------

  private async restore(): Promise<void> {
    this.protocols = (await store.get<Protocol[]>('protocols')) ?? [];
    this.filter = { ...NO_FILTER, ...((await store.get<CaptureFilter>('filter')) ?? {}) };
    const saved = (await store.allBursts()).sort((a, b) => a.id - b.id);
    for (const s of saved) {
      const b = s as unknown as AnBurst;
      const auto = analyze(b.env, b.fm, b.n, b.rate);
      this.bursts.push({ ...b, auto, best: bestOf(auto), seenAt: 0, proto: null, over: b.over ?? {}, name: b.name ?? '', note: b.note ?? '', star: !!b.star });
      this.lastId = Math.max(this.lastId, b.id);
    }
    this.recognizeAll();
    this.draw();
  }

  private save(b: AnBurst): void {
    const { auto: _a, best: _b, proto: _p, seenAt: _s, ...rest } = b;
    void _a; void _b; void _p; void _s;
    void store.putBurst(rest as unknown as StoredBurst);
  }
  private saveProtocols(): void { void store.set('protocols', this.protocols); }

  // ---- what the worker sends ----------------------------------------------------------------------------------

  onBurst(raw: Burst, fromFile: boolean): void {
    const center = fromFile ? (freqFromName(raw.src ?? '') ?? 0) : this.host.center();
    if (!passes(this.filter, raw, center)) { this.filtered++; this.refresh(); return; }
    const auto = analyze(raw.env, raw.fm, raw.n, raw.rate);
    const b: AnBurst = { ...raw, id: ++this.lastId, center, auto, best: bestOf(auto), name: '', star: false, note: '', over: {}, seenAt: fromFile ? 0 : performance.now(), proto: null };
    b.proto = recognize(this.protocols, b.best, auto.mod, auto.coding);
    this.bursts.push(b);
    this.save(b);
    this.trim();
    if (!this.sel || (fromFile && !this.bursts.some(x => x.id === this.sel))) this.sel = b.id;
    this.refresh();
  }
  onStats(m: { channels: number; followed: number; captured: number; span: number }): void { this.stats = m; this.refresh(); }
  onImport(m: { name: string; count: number; note: string }): void { this.host.log(`Analyzer: ${m.count} burst${m.count === 1 ? '' : 's'} in ${m.name}${m.note ? ` (${m.note})` : ''}`); this.flash(`${m.count} BURST${m.count === 1 ? '' : 'S'} IN ${m.name}`); }

  /** Past the limit, the oldest unstarred bursts go. */
  private trim(): void {
    while (this.bursts.length > MAX_KEPT) {
      const i = this.bursts.findIndex(x => !x.star);
      if (i < 0) break;
      const gone = this.bursts.splice(i, 1)[0];
      this.left.delete(gone.id); void store.deleteBurst(gone.id);
    }
  }

  /** CLEAR keeps starred bursts; a second CLEAR within 3 s clears them too. */
  clear(): void {
    const all = Date.now() - this.clearArmed < 3000;
    this.clearArmed = Date.now();
    for (let i = this.bursts.length - 1; i >= 0; i--) {
      if (!all && this.bursts[i].star) continue;
      void store.deleteBurst(this.bursts[i].id);
      this.bursts.splice(i, 1);
    }
    this.left.clear(); this.filtered = 0;
    if (!this.selected()) { this.sel = 0; this.opened = false; this.comparing = false; }
    this.zoom = this.pick = null;
    this.draw();
    this.flash(all ? 'CLEARED, STARRED TOO' : this.bursts.length ? `KEPT ${this.bursts.length} STARRED · CLEAR AGAIN TO DROP THEM` : 'CLEARED');
  }

  private recognizeAll(): void { for (const b of this.bursts) b.proto = recognize(this.protocols, b.best, b.auto.mod, b.auto.coding); }

  // ---- the screen -------------------------------------------------------------------------------------------

  /** The Analyzer's own part of the screen, under the waterfall and the band presets main.ts draws. */
  html(): string {
    return `
      <div class="ctlrow an-ctlrow"><button id="an-cap" class="tog">CAPTURE</button><button id="an-imp" class="tog">IMPORT</button><button id="an-filt" class="tog">FILTER</button><button id="an-star" class="tog">☆ STARRED</button><button id="an-sess" class="tog">EXPORT SESSION</button><input id="an-file" type="file" accept=".cu8,.cs8,.u8,.iq,.raw,.sub,.mmanalyzer" hidden><span class="row an-grow"></span><button class="ib" id="an-clear" title="clear (starred bursts stay; tap twice to clear them too)" aria-label="clear">✕</button></div>
      <div id="an-filter" class="an-filter" hidden></div>
      <div id="an-stats" class="mt-sum"><div>listening&hellip;</div></div>
      <div id="an-list" class="mt-cards an-cards"></div>
      <div id="an-modal" class="an-modal" hidden><div class="an-sheet" id="an-detail"></div></div>
      <div class="note">Every burst in the span is tuned to on its own and kept whole, from 12 ms before it began, and boxed on the waterfall where it was heard (tap a box to open it). Open one to see it four ways with its bits marked under the trace, read it to bits (the modulation, symbol length, threshold and line coding are worked out, and each can be set by hand), and COMPARE to line its repeats up bit by bit: SUGGEST names the preamble, sync, ID, counter and checksum, and a set of named fields saves as a protocol that is recognized from then on. Captures are kept between visits; star the ones that matter. Export one as raw I/Q or a Flipper .sub, send it to Transmit, or export the whole session.</div>`;
  }

  mount(root: HTMLElement): void {
    this.root = root;
    const $ = (id: string) => root.querySelector<HTMLElement>('#' + id)!;
    const cap = $('an-cap');
    cap.classList.toggle('on', this.capturing);
    cap.onclick = () => { this.capturing = !this.capturing; cap.classList.toggle('on', this.capturing); this.host.post({ type: 'analyzer', cmd: 'pause', on: !this.capturing }); this.draw(); };
    const file = $('an-file') as HTMLInputElement;
    $('an-imp').onclick = () => file.click();
    file.onchange = async () => {
      const f = file.files?.[0]; file.value = '';
      if (!f) return;
      this.flash(`READING ${f.name}…`);
      const bytes = await f.arrayBuffer();
      if (/\.mmanalyzer$/i.test(f.name)) this.importSession(new Uint8Array(bytes), f.name);
      else this.host.post({ type: 'analyzer', cmd: 'import', name: f.name, bytes }, [bytes]);
    };
    $('an-filt').onclick = () => { this.showFilter = !this.showFilter; this.draw(); };
    $('an-star').onclick = () => { this.starredOnly = !this.starredOnly; this.draw(); };
    $('an-sess').onclick = () => this.exportSession();
    $('an-clear').onclick = () => this.clear();
    $('an-list').onclick = (e) => {
      const c = (e.target as HTMLElement).closest<HTMLElement>('[data-an]');
      if (c) this.openTransmission(+c.dataset.an!);
    };
    $('an-modal').onclick = (e) => { if (e.target === $('an-modal')) this.close(); };
    // a box on the waterfall opens its burst; the waterfall's own tap (tuning) is left alone everywhere else
    const sc = root.querySelector<HTMLElement>('#scope');
    sc?.addEventListener('pointerdown', (e) => {
      const id = this.host.scope()?.markAt(e.clientX, e.clientY);
      if (id) { e.stopPropagation(); e.preventDefault(); this.openTransmission(id); }
    }, true);
    clearInterval(this.marksTimer);
    this.marksTimer = window.setInterval(() => { if (!this.host.showing()) { clearInterval(this.marksTimer); this.host.scope()?.setMarks([]); return; } this.marks(); }, 500);
    this.host.post({ type: 'analyzer', cmd: 'pause', on: !this.capturing });
    this.draw();
  }

  /** Keys while the full-screen view is open: Esc steps back out of it. */
  onKey(e: KeyboardEvent): boolean {
    if (!this.opened || e.key !== 'Escape') return false;
    this.back();
    return true;
  }

  /** One step back: compare → what it was opened from; a frame → its transmission; the rest closes. */
  private back(): void {
    if (this.comparing) { this.comparing = false; this.colPick = null; }
    else if (this.txOpen && this.txBurst) this.txBurst = false;
    else { this.close(); return; }
    this.draw();
  }

  private openBurst(id: number): void {
    if (id !== this.sel) { this.sel = id; this.zoom = this.pick = null; this.hl = null; this.cursors = [null, null]; this.hist = [null]; this.histAt = 0; }
    this.comparing = false;
    this.opened = true;
    this.draw();
  }
  /** Open the transmission a burst belongs to: its frames, or the burst itself when it was sent once. */
  private openTransmission(id: number): void {
    const t = this.txs().find(x => x.ids.includes(id));
    if (!t || t.ids.length === 1) { this.txOpen = 0; this.txBurst = false; this.openBurst(t ? t.ids[0] : id); return; }
    this.txOpen = t.id; this.txBurst = false; this.comparing = false; this.opened = true;
    if (!t.ids.includes(this.sel)) { this.sel = t.ids[0]; this.zoom = this.pick = null; this.hl = null; }
    this.draw();
  }
  private close(): void { this.opened = false; this.comparing = false; this.txOpen = 0; this.txBurst = false; this.colPick = null; this.draw(); }

  /** The kept bursts as transmissions: each press once, its copies and channels together. */
  private txs(): Tx[] {
    const byId = new Map(this.bursts.map(b => [b.id, b]));
    return groupPresses(this.bursts.map(b => ({ id: b.id, t: b.src ? b.t : b.wall / 1000 - b.n / b.rate, dur: b.n / b.rate, hz: b.center ? b.center + b.hz : b.hz, matches: b.matches, bits: b.best, src: b.src })))
      .map(t => ({ ...t, members: t.ids.map(i => byId.get(i)!) }));
  }

  private flash(s: string): void { const st = this.root?.querySelector('#an-stats'); if (st) st.innerHTML = `<div>${esc(s)}</div>`; }

  /** Coalesced: bursts can arrive several at once, and redrawing the list under a finger is unpleasant. */
  refresh(): void {
    if (this.pending || !this.host.showing()) return;
    this.pending = window.setTimeout(() => { this.pending = 0; this.draw(false); }, 200);
  }

  private selected(): AnBurst | undefined { return this.bursts.find(b => b.id === this.sel); }

  /** What the trace shows: the zoom if there is one, else the burst itself with a little either side. */
  private shown(b: AnBurst): [number, number] {
    if (this.zoom) return this.zoom;
    const a = b.auto, pad = Math.max(16, Math.round((a.to - a.from) * 0.06));
    return a.to > a.from ? [Math.max(0, a.from - pad), Math.min(b.n, a.to + pad)] : [0, b.n];
  }

  /** The selected burst read with whatever has been set by hand. */
  private reading(b: AnBurst): Analysis {
    const o = { ...b.over };
    if (this.selOnly && (this.pick || this.zoom)) { const r = this.pick ?? this.zoom!; o.from = r[0]; o.to = r[1]; }
    if (!Object.keys(o).length) return b.auto;
    const key = `${b.id}:${JSON.stringify(o)}`;
    if (this.readCache?.key !== key) this.readCache = { key, a: analyze(b.env, b.fm, b.n, b.rate, o) };
    return this.readCache.a;
  }

  /** Each live burst boxed on the waterfall, while the radio sits where it was heard. */
  private marks(): void {
    const sc = this.host.scope();
    if (!sc) return;
    const c = this.host.center(), rate = this.host.rate(), now = performance.now();
    const open = this.opened ? (this.txOpen ? this.txs().find(t => t.id === this.txOpen)?.ids ?? [] : [this.sel]) : [];
    const out: ScopeMark[] = [];
    for (const b of this.bursts) {
      if (!b.seenAt || b.center !== c) continue;
      const alpha = 1 - (now - b.seenAt) / MARK_FADE_MS;
      if (alpha <= 0) continue;
      // the whole stretch the burst was heard over, from the look-back to the end of its carrier
      const t1 = b.seenAt - 210, t0 = t1 - Math.max(b.n / b.rate * 1000 - 70, b.ms, 4);
      const w = Math.max(20_000, b.auto.mod === 'FSK' ? b.auto.shiftHz * 1.6 : 0) / rate;
      const label = `${((c + b.hz) / 1e6).toFixed(3)}${b.matches.length ? ` ${shortLabel(b.matches[0])}` : b.proto ? ` ${b.proto.protocol.name}` : ''}`;
      out.push({ id: b.id, t0, t1, frac: 0.5 + b.hz / rate, w, color: MOD_COLOR[b.auto.mod], bold: open.includes(b.id), label, alpha: Math.max(0.15, alpha) });
    }
    sc.setMarks(out);
  }

  draw(full = true): void {
    const root = this.root;
    if (!root || !root.isConnected) return;
    const $ = (id: string) => root.querySelector<HTMLElement>('#' + id);
    $('an-filt')?.classList.toggle('on', this.showFilter || !sameFilter(this.filter, NO_FILTER));
    $('an-star')?.classList.toggle('on', this.starredOnly);
    const st = $('an-stats');
    if (st) {
      const s = this.stats, c = this.host.center();
      const txs = this.txs(), matched = txs.filter(t => t.label).length, protos = txs.filter(t => t.members.some(m => m.proto)).length;
      st.innerHTML = (s ? `<div>WATCHING ${((c - s.span / 2) / 1e6).toFixed(2)}–${((c + s.span / 2) / 1e6).toFixed(2)} MHz${s.channels ? ` · TUNED TO ${s.channels} BURST${s.channels === 1 ? '' : 'S'} NOW` : ''}${this.capturing ? '' : ' · CAPTURE OFF'}</div>` : `<div>${this.capturing ? 'listening…' : 'CAPTURE OFF'}</div>`)
        + `<div class="muted">${txs.length} transmission${txs.length === 1 ? '' : 's'} (${this.bursts.length} frame${this.bursts.length === 1 ? '' : 's'}) · ${matched} matched a Devices decoder${protos ? ` · ${protos} a saved protocol` : ''}${this.filtered ? ` · ${this.filtered} filtered out` : ''}${s ? ` · ${s.followed} bursts followed` : ''}</div>`;
    }
    const fl = $('an-filter');
    if (fl) { fl.hidden = !this.showFilter; if (this.showFilter && full) { fl.innerHTML = this.filterHtml(); this.wireFilter(fl); } }
    const list = $('an-list');
    if (list) {
      const top = list.scrollTop;
      const shown = this.txs().filter(t => !this.starredOnly || t.members.some(m => m.star));
      list.innerHTML = shown.length
        ? [...shown].reverse().map(t => (t.members.length === 1 ? this.card(t.members[0]) : this.txCard(t))).join('')
        : `<div class="mt-wait dv-empty">${this.starredOnly ? 'nothing starred yet: open a burst and tap ☆' : 'nothing yet. Press a key fob or a remote near the antenna, or IMPORT a recording (.cu8 .cs8 .sub) or a session (.mmanalyzer)'}</div>`;
      list.scrollTop = top;
    }
    this.marks();
    const modal = $('an-modal'), det = $('an-detail');
    const b = this.selected();
    const tx = this.txOpen ? this.txs().find(t => t.id === this.txOpen) : undefined;
    if (this.txOpen && !tx) { this.txOpen = 0; this.txBurst = false; }
    if (modal && det) {
      modal.hidden = !(this.opened && (b || tx));
      // a new burst arriving must not rebuild the open view under the person's hands
      if (this.opened && full) {
        if (this.comparing && b) { det.innerHTML = this.compareHtml(b); this.wireCompare(det, b); }
        else if (tx && !this.txBurst) { det.innerHTML = this.txHtml(tx); this.wireTx(det, tx); }
        else if (b) { det.innerHTML = this.detailHtml(b); this.wireDetail(det, b); }
      }
    }
  }

  private card(b: AnBurst): string {
    const a = b.auto;
    const hz = b.center ? mhz(b.center + b.hz) : `${b.hz >= 0 ? '+' : ''}${(b.hz / 1e3).toFixed(0)} kHz`;
    const when = b.src ? `+${b.t.toFixed(3)} s` : clock(b.wall);
    const big = a.frames.length ? `${a.mod} · ${a.coding.toUpperCase()}` : a.mod === 'OOK' && a.why.startsWith('a plain') ? 'CARRIER' : a.mod;
    const sub = a.frames.length ? `${rateLabel(a.baud)} · ${b.best.length} bits${a.frames.length > 1 ? ` · ${a.frames.length} frames` : ''}` : a.why;
    return `<div class="mt-card dv-card an-card k-${a.mod.toLowerCase()} ${this.sel === b.id ? 'sel' : ''}" data-an="${b.id}">`
      + `<div class="mt-h"><span class="dv-glyph">${WAVE_GLYPH}</span><span class="mt-k"><b>${esc(hz)}</b><small>${b.name ? `<em class="an-name">${esc(b.name)}</em>` : b.src ? esc(b.src) : `burst ${b.id}`}</small></span><span class="mt-live">${b.star ? '<i class="an-starred">★</i>' : ''}${esc(when)}</span></div>`
      + `<div class="mt-clk"><b>${esc(big)}</b><small>${esc(sub)}</small></div>`
      + (b.best ? `<div class="mt-hex">${esc(bitsToHex(b.best))}</div>` : '')
      + (b.matches.length || b.proto ? `<div class="an-match">${b.proto ? `<span class="p">◆ ${esc(b.proto.protocol.name)}</span>` : ''}${b.matches.map(m => `<span>${esc(m)}</span>`).join('')}</div>` : '')
      + (b.note ? `<div class="an-note">${esc(b.note)}</div>` : '')
      + `<div class="dv-foot"><span>${b.ms.toFixed(1)} ms</span><span>${b.dbfs.toFixed(0)} dBFS · ${b.snr.toFixed(0)} dB SNR</span></div></div>`;
  }

  /** A press sent several times: what it is, how often and where. */
  private txCard(t: Tx): string {
    const m0 = t.members[0], rep = repOf(t), a = rep.auto;
    const name = t.members.find(x => x.name)?.name ?? '';
    const proto = t.members.find(x => x.proto)?.proto?.protocol.name ?? '';
    const big = t.label ? shortLabel(t.label) : proto || (a.frames.length ? `${a.mod} · ${a.coding.toUpperCase()}` : a.mod);
    const when = m0.src ? `+${m0.t.toFixed(3)} s` : clock(m0.wall);
    const chans = `${t.freqs.length} channel${t.freqs.length === 1 ? '' : 's'}`;
    const snr = Math.max(...t.members.map(x => x.snr));
    const open = this.opened && this.txOpen === t.id;
    return `<div class="mt-card dv-card an-card an-txcard k-${a.mod.toLowerCase()} ${open || t.ids.includes(this.sel) ? 'sel' : ''}" data-an="${t.id}">`
      + `<div class="mt-h"><span class="dv-glyph">${WAVE_GLYPH}</span><span class="mt-k"><b>${t.freqs.map(f => (f / 1e6).toFixed(3)).join(' / ')} MHz</b><small>${name ? `<em class="an-name">${esc(name)}</em>` : m0.src ? esc(m0.src) : `${a.mod} · ${a.coding}`}</small></span><span class="mt-live">${t.members.some(x => x.star) ? '<i class="an-starred">★</i>' : ''}${esc(when)}</span></div>`
      + `<div class="mt-clk"><b>${esc(big)}</b><small>${t.ids.length} frames on ${chans}</small></div>`
      + (rep.best ? `<div class="mt-hex">${esc(bitsToHex(rep.best))}</div>` : '')
      + (proto && t.label ? `<div class="an-match"><span class="p">◆ ${esc(proto)}</span></div>` : '')
      + `<div class="dv-foot"><span>${((t.end - t.t) * 1000).toFixed(0)} ms in all</span><span>up to ${snr.toFixed(0)} dB SNR</span></div></div>`;
  }

  /** The transmission view: one press, each frame it was sent as, and a COMPARE across them. */
  private txHtml(t: Tx): string {
    const m0 = t.members[0];
    const rows = t.members.map(m => {
      const hz = m.center ? mhz(m.center + m.hz) : `${(m.hz / 1e3).toFixed(1)} kHz`;
      const off = m.src ? `+${m.t.toFixed(3)} s` : `+${((m.wall - m0.wall) / 1000).toFixed(3)} s`;
      return `<div class="an-txrow ${m.id === this.sel ? 'me' : ''}" data-anf="${m.id}"><b>${esc(hz)}</b><span>${off} · ${m.auto.mod} · ${m.auto.coding} · ${m.ms.toFixed(1)} ms · ${m.snr.toFixed(0)} dB</span><code>${esc(bitsToHex(m.best)) || '—'}</code></div>`;
    }).join('');
    return `<div class="an-head"><b>${esc(t.label ? shortLabel(t.label) : 'TRANSMISSION')}</b><span>${t.ids.length} frames on ${t.freqs.length} channel${t.freqs.length === 1 ? '' : 's'} · ${t.freqs.map(f => (f / 1e6).toFixed(3)).join(' / ')} MHz · ${m0.src ? esc(m0.src) : clock(m0.wall)}</span>`
      + `<button class="chip" data-ando="txcompare">COMPARE</button><button class="chip" data-ando="close" title="close (Esc)">✕</button></div>`
      + `<div class="an-scroll"><div class="an-sub">EACH FRAME AS IT WAS HEARD · TAP ONE TO OPEN IT</div><div class="an-txrows">${rows}</div>`
      + `${t.label ? `<div class="an-why">DEVICES DECODERS: ${esc(t.label)}</div>` : ''}</div>`;
  }
  private wireTx(det: HTMLElement, t: Tx): void {
    det.querySelectorAll<HTMLElement>('[data-anf]').forEach(r => r.onclick = () => { const id = +r.dataset.anf!; if (id !== this.sel) { this.sel = id; this.zoom = this.pick = null; this.hl = null; } this.txBurst = true; this.draw(); });
    det.querySelectorAll<HTMLButtonElement>('[data-ando]').forEach(x => x.onclick = () => {
      if (x.dataset.ando === 'close') this.close();
      else { this.cmpTx = t.id; this.comparing = true; this.fields = []; this.check = null; this.colPick = null; this.sel = repOf(t).id; this.draw(); }
    });
  }

  // ---- the capture filter -------------------------------------------------------------------------------------

  private filterHtml(): string {
    const f = this.filter, mhzv = (hz: number) => (hz ? (hz / 1e6).toString() : '');
    const num = (id: string, v: string, ph: string) => `<input id="${id}" class="txin" inputmode="decimal" value="${esc(v)}" placeholder="${ph}">`;
    return `<span class="rl">FREQ MHz</span>${num('anf-lo', mhzv(f.loHz), 'from')}${num('anf-hi', mhzv(f.hiHz), 'to')}`
      + `<span class="rl">SNR ≥ dB</span>${num('anf-snr', f.minSnr ? String(f.minSnr) : '', 'any')}`
      + `<span class="rl">LENGTH ms</span>${num('anf-min', f.minMs ? String(f.minMs) : '', 'min')}${num('anf-max', f.maxMs ? String(f.maxMs) : '', 'max')}`
      + `<button class="tog ${f.unknownOnly ? 'on' : ''}" id="anf-unk">ONLY UNKNOWN</button><button class="tog" id="anf-reset">NO FILTER</button>`;
  }
  private wireFilter(el: HTMLElement): void {
    const v = (id: string) => parseFloat((el.querySelector<HTMLInputElement>('#' + id)!.value || '').replace(',', '.')) || 0;
    const apply = () => {
      this.filter = { loHz: Math.round(v('anf-lo') * 1e6), hiHz: Math.round(v('anf-hi') * 1e6), minSnr: v('anf-snr'), minMs: v('anf-min'), maxMs: v('anf-max'), unknownOnly: this.filter.unknownOnly };
      void store.set('filter', this.filter); this.draw(false);
    };
    el.querySelectorAll<HTMLInputElement>('input').forEach(i => i.onchange = apply);
    el.querySelector<HTMLElement>('#anf-unk')!.onclick = () => { this.filter = { ...this.filter, unknownOnly: !this.filter.unknownOnly }; void store.set('filter', this.filter); this.draw(); };
    el.querySelector<HTMLElement>('#anf-reset')!.onclick = () => { this.filter = { ...NO_FILTER }; void store.set('filter', this.filter); this.draw(); };
  }

  // ---- the full-screen view of one burst ----------------------------------------------------------------------

  private detailHtml(b: AnBurst): string {
    const a = this.reading(b), o = b.over;
    const hz = b.center ? mhz(b.center + b.hz) : `${(b.hz / 1e3).toFixed(1)} kHz off center`;
    const seg = (name: string, vals: string[], cur: string, label = (v: string) => v) => `<div class="seg an-seg">${vals.map(v => `<button data-an${name}="${v}" class="${cur === v ? 'on' : ''}">${label(v)}</button>`).join('')}</div>`;
    const why = `${a.mod} (${esc(a.why)}) · ${a.coding} · symbol ${a.symUs.toFixed(1)} µs · ${rateLabel(a.baud)}${a.mod === 'FSK' ? ` · shift ${(a.shiftHz / 1e3).toFixed(1)} kHz` : ''}`;
    const proto = b.proto;
    const fieldsHtml = proto ? (() => {
      const p = proto.protocol, ok = checkHolds(p, b.best, proto.start);
      return `<div class="an-sub">◆ ${esc(p.name.toUpperCase())}${ok === null ? '' : ok ? ' · CHECK ✓' : ' · CHECK ✗'}</div><div class="an-fields">${p.fields.map(f => `<div><i style="background:${KIND_COLOR[f.kind]}"></i><b>${esc(f.name)}</b><span>${esc(fieldValue(b.best, proto.start, f))}</span></div>`).join('')}</div>`;
    })() : '';
    const fit = symbolFit(a, b.rate), drift = clockDrift(a, b.rate);
    const pt = this.pulsesOf(b, a), segs = frameSegments(a, b.rate), lv = levels(a, b.env, b.fm, b.rate);
    const sec = (id: string, title: string, body: string, copy = true) => `<details class="an-sec" data-ansec="${id}" ${this.openSec.has(id) ? 'open' : ''}><summary><b>${title}</b>${copy ? `<button class="chip" data-ancopy="${id}">COPY</button>` : ''}</summary>${body}</details>`;
    const histHtml = `<div class="an-sub">PULSE LENGTHS <i class="mk">marks</i> <i class="sp">gaps</i> · dashed: the threshold between classes</div><canvas id="an-hist" class="an-hist"></canvas>`;
    return `<div class="an-head"><b>${esc(hz)}</b><span>${b.name ? `<em class="an-name">${esc(b.name)}</em> · ` : ''}${b.src ? esc(b.src) + ' · +' + b.t.toFixed(3) + ' s' : clock(b.wall)} · ${b.ms.toFixed(1)} ms · ${b.snr.toFixed(0)} dB SNR</span>`
      + `<button class="chip an-starbtn ${b.star ? 'on' : ''}" data-ando="star" title="star: kept through CLEAR">${b.star ? '★' : '☆'}</button><button class="chip" data-ando="compare">COMPARE</button><button class="chip" data-ando="tx" ${a.runs.length ? '' : 'disabled'}>SEND TO TX</button>${this.txOpen ? '<button class="chip" data-ando="back">BACK</button>' : ''}<button class="chip" data-ando="close" title="close (Esc)">✕</button></div>`
      + `<div class="ctlrow">${seg('view', ['amp', 'freq', 'iq', 'spec', 'eye', 'const'], this.view, v => `<span class="lg">${VIEW_LABEL[v as View]}</span><span class="sh">${VIEW_SHORT[v as View]}</span>`)}</div>`
      + `<div class="an-tools">${seg('tool', ['select', 'measure', 'pan'], this.tool, v => v.toUpperCase())}`
      + `<span class="an-btns"><button class="chip" data-annav="out" title="zoom out (wheel)">−</button><button class="chip" data-annav="in" title="zoom in (wheel)">+</button><button class="chip" data-annav="fit" title="the burst">FIT</button><button class="chip" data-annav="full" title="the whole capture">FULL</button><button class="chip" data-annav="sel" ${this.pick ? '' : 'disabled'} title="zoom to the selection">ZOOM</button><button class="chip" data-annav="back" ${this.histAt > 0 ? '' : 'disabled'} title="previous zoom">◀</button><button class="chip" data-annav="fwd" ${this.histAt < this.hist.length - 1 ? '' : 'disabled'} title="next zoom">▶</button></span>`
      + `<span class="an-btns"><button class="chip" data-annav="ydn" title="vertical zoom out (Alt+wheel)">Y−</button><button class="chip" data-annav="yup" title="vertical zoom in (Alt+wheel)">Y+</button><button class="chip ${this.yz[this.view] === 1 ? 'on' : ''}" data-annav="yauto">Y AUTO</button></span>`
      + `<span class="an-btns"><button class="tog ${this.samplesAxis ? 'on' : ''}" data-annav="axis">${this.samplesAxis ? 'SAMPLES' : 'TIME'}</button><button class="tog ${this.showDur ? 'on' : ''}" data-annav="dur">DURATIONS</button><button class="tog ${this.showClock ? 'on' : ''}" data-annav="clock">CLOCK</button></span></div>`
      + `<canvas id="an-mini" class="an-mini" title="the whole burst: drag the box to pan, click to jump"></canvas>`
      + `<div class="an-wave"><canvas id="an-canvas"></canvas></div>`
      + `<div class="an-cur" id="an-cur">${this.cursorText(b, a)}</div>`
      + `<div class="an-zoom"><span id="an-selinfo">${this.selText(b, a)}</span><span class="an-grow"></span>${seg('fmt', ['bits', 'hex', 'ascii'], this.fmt, v => v.toUpperCase())}</div>`
      + `<div class="an-out" id="an-out">${this.outHtml(a)}</div>`
      + `<div class="an-scroll">`
      + sec('demod', 'DEMODULATION', `<div class="an-ctl"><span class="rl">MOD</span>${seg('mod', ['AUTO', ...MODS], o.mod ?? 'AUTO')}<span class="rl">CODING</span>${seg('coding', ['AUTO', ...CODINGS], o.coding ?? 'AUTO', v => (v === 'AUTO' ? v : CODING_LABEL[v as Coding]))}</div>`
        + `<div class="an-ctl"><span class="rl">SYMBOL</span><div class="stepper an-step"><button data-ando="sym-">−</button><b>${a.symUs.toFixed(1)} µs</b><button data-ando="sym+">+</button></div><button class="tog ${o.symUs ? '' : 'on'}" data-ando="symauto">AUTO</button>`
        + `<span class="rl">CUT</span><input id="an-thr" type="range" min="2" max="98" value="${Math.round(a.thr * 100)}"><b class="an-pct">${Math.round(a.thr * 100)}%</b><button class="tog ${o.thr !== undefined ? '' : 'on'}" data-ando="thrauto">AUTO</button>`
        + `<button class="tog ${o.invert ? 'on' : ''}" data-ando="invert">INVERT</button><button class="tog ${this.selOnly ? 'on' : ''}" data-ando="selonly">SELECTION ONLY</button></div>`
        + `<div class="an-why">${why}</div>`
        + `<div class="an-why">SYMBOL ${fit.symUs.toFixed(1)} µs ± ${fit.errPct.toFixed(1)}% over ${fit.runs} runs · ${rateLabel(fit.baud)}${drift.length ? ` · CLOCK DRIFT worst ${Math.max(...drift.map(d => d.worstPct)).toFixed(0)}%, mean ${(drift.reduce((s, d) => s + d.meanPct, 0) / drift.length).toFixed(0)}% of a symbol` : ''}</div>`)
      + sec('pulses', `PULSES · ${pt.pulses.length}`, histHtml + this.pulsesHtml(pt))
      + sec('frames', `FRAMES · ${segs.length}`, this.framesHtml(segs))
      + sec('levels', 'LEVELS', this.levelsHtml(a, lv))
      + fieldsHtml
      + `<div class="an-why">${b.matches.length ? `DEVICES DECODERS: ${b.matches.map(esc).join(' · ')}` : 'no Devices decoder claimed it'}</div>`
      + `<div class="an-ctl"><span class="rl">NAME</span><input id="an-nm" class="txin an-grow" maxlength="60" value="${esc(b.name)}" placeholder="what it is (gate, left key, lock…)"></div>`
      + `<div class="an-ctl"><span class="rl">NOTE</span><textarea id="an-nt" class="txin an-grow" rows="2" maxlength="500" placeholder="anything worth remembering about it">${esc(b.note)}</textarea></div>`
      + `<div class="an-ctl"><span class="rl">EXPORT</span><button class="chip" data-ando="cu8">.CU8</button><button class="chip" data-ando="cs8">.CS8</button><button class="chip" data-ando="sub" ${a.runs.length ? '' : 'disabled'}>.SUB</button><button class="chip" data-ando="csv">${this.pick ? 'SELECTION' : 'VIEW'} .CSV</button><span class="an-dim">${(b.rate / 1e3).toFixed(0)} kHz I/Q, ${b.n} samples</span></div>`
      + `</div>`;
  }

  // ---- measurements -------------------------------------------------------------------------------------------

  /** The pulse table, computed once per reading. */
  private pulsesOf(b: AnBurst, a: Analysis): PulseTable {
    if (this.ptCache && this.ptCache.a === a) return this.ptCache.t;
    const t = pulseTable(a, b.rate, b.env);
    this.ptCache = { a, t };
    return t;
  }

  private pulsesHtml(t: PulseTable): string {
    const row = (c: PulseClass, i: number) => `<tr><td><b class="${c.hi ? 'mk' : 'sp'}">${c.hi ? 'M' : 'G'}${i + 1}</b></td><td>${c.count}</td><td>${c.mean.toFixed(1)}</td><td>${c.min.toFixed(1)}</td><td>${c.max.toFixed(1)}</td><td>${c.sd.toFixed(1)}</td><td>${c.jitterPct.toFixed(1)}%</td><td>${c.symbols.toFixed(2)}</td></tr>`;
    const classes = `<table class="an-tbl"><thead><tr><th>CLASS</th><th>COUNT</th><th>MEAN µs</th><th>MIN</th><th>MAX</th><th>σ</th><th>JITTER</th><th>SYMBOLS</th></tr></thead><tbody>${t.marks.map(row).join('')}${t.spaces.map(row).join('')}</tbody></table>`;
    const cuts = `<div class="an-why">THRESHOLDS · marks ${t.markCuts.map(x => `${x.toFixed(0)} µs`).join(', ') || 'one class'} · gaps ${t.spaceCuts.map(x => `${x.toFixed(0)} µs`).join(', ') || 'one class'}</div>`;
    const list = `<div class="an-plist">${t.pulses.slice(0, 2000).map(p => `<span class="${p.hi ? 'mk' : 'sp'}" title="F${p.frame + 1} #${p.index} · sample ${p.start}">${p.us.toFixed(0)}<i>${p.hi ? 'M' : 'G'}${p.cls + 1}</i></span>`).join('')}</div>`;
    return classes + cuts + list;
  }

  private framesHtml(segs: FrameSeg[]): string {
    if (!segs.length) return '<div class="mt-wait">no frames</div>';
    const hexDiff = (s: FrameSeg) => { const d = new Set(s.diff.map(k => k >> 2)); return [...s.hex].map((ch, i) => (d.has(i) ? `<em>${ch}</em>` : ch)).join(''); };
    return `<table class="an-tbl an-ftbl"><thead><tr><th>FRAME</th><th>START ms</th><th>LENGTH ms</th><th>GAP ms</th><th>INTERVAL ms</th><th>BITS</th><th>HEX · differences from F1 lit</th></tr></thead><tbody>`
      + segs.map(s => `<tr><td><b>F${s.index + 1}</b></td><td>${s.startMs.toFixed(3)}</td><td>${(s.endMs - s.startMs).toFixed(3)}</td><td>${s.index ? s.gapMs.toFixed(3) : '—'}</td><td>${s.index ? s.intervalMs.toFixed(3) : '—'}</td><td>${s.bits}</td><td class="hx">${hexDiff(s)}${s.index ? (s.diff.length ? ` <small>${s.diff.length} bits differ</small>` : ' <small>same as F1</small>') : ''}</td></tr>`).join('')
      + '</tbody></table>';
  }

  private levelsHtml(a: Analysis, lv: Levels): string {
    const kv = (k: string, v: string) => `<div><b>${k}</b><span>${v}</span></div>`;
    const rows: string[] = [];
    if (a.mod !== 'FSK') {
      rows.push(kv('MARK', `${lv.markDbfs.toFixed(1)} dBFS`), kv('GAP', `${lv.spaceDbfs.toFixed(1)} dBFS`), kv(a.mod === 'OOK' ? 'OOK DEPTH' : 'DEPTH', `${lv.depthDb.toFixed(1)} dB`));
      rows.push(kv('RISE 10→90%', `${lv.riseUs.toFixed(1)} µs`), kv('FALL 90→10%', `${lv.fallUs.toFixed(1)} µs`), kv('CARRIER OFFSET', `${(lv.carrierHz / 1e3).toFixed(2)} kHz`));
      if (a.mod === 'ASK') rows.push(kv('ASK LEVELS', `${lv.askLoDbfs.toFixed(1)} / ${lv.askHiDbfs.toFixed(1)} dBFS`));
    } else {
      rows.push(kv('LOW TONE', `${(lv.toneLoHz / 1e3).toFixed(2)} kHz`), kv('HIGH TONE', `${(lv.toneHiHz / 1e3).toFixed(2)} kHz`), kv('CENTER OFFSET', `${(lv.centerHz / 1e3).toFixed(2)} kHz`));
      rows.push(kv('DEVIATION', `±${(lv.deviationHz / 1e3).toFixed(2)} kHz`), kv('LEVEL', `${lv.markDbfs.toFixed(1)} dBFS`));
    }
    const m = Math.max(1, ...lv.toneHist);
    const bars = lv.toneHist.map((v, i) => `<i style="height:${(v / m * 100).toFixed(0)}%" title="${(i - 30) * 2} kHz: ${v}"></i>`).join('');
    return `<div class="an-kv">${rows.join('')}</div><div class="an-sub">TONES INSIDE THE CARRIER · −60 … +60 kHz, 2 kHz bins</div><div class="an-tones">${bars}</div>`;
  }

  private cursorText(b: AnBurst, a: Analysis): string {
    const [A, B] = this.cursors;
    if (A === null && B === null) return `<span class="an-dim">${this.tool === 'measure' ? 'click the trace to place cursor A, then B; drag a cursor to move it' : 'MEASURE: place cursors A and B · wheel or pinch to zoom · shift-drag or PAN to move'}</span>`;
    const parts: string[] = [];
    const at = (s: number) => (this.samplesAxis ? `#${s}` : fmtTime(s / b.rate, 1e-6));
    if (A !== null) parts.push(`<b class="ca">A</b> ${at(A)} · ${valueAt(this.view, b, A)}`);
    if (B !== null) parts.push(`<b class="cb">B</b> ${at(B)} · ${valueAt(this.view, b, B)}`);
    if (A !== null && B !== null) {
      const d = Math.abs(B - A), dt = d / b.rate;
      parts.push(`Δt ${fmtTime(dt, 1e-6)} · 1/Δt ${dt ? (1 / dt >= 1000 ? `${(1 / dt / 1000).toFixed(3)} kHz` : `${(1 / dt).toFixed(1)} Hz`) : '—'} · Δ ${d} samples · ${a.symUs ? (dt * 1e6 / a.symUs).toFixed(2) : '—'} symbols`);
    }
    return parts.join(' <i>·</i> ') + ` <button class="chip" data-ancopy="cursors">COPY</button><button class="chip" data-annav="nocur">CLEAR</button>`;
  }

  private selText(b: AnBurst, a: Analysis): string {
    const r = this.pick;
    if (!r) { const [a0, a1] = this.shown(b); return `showing ${fmtTime((a1 - a0) / b.rate, 1e-6)} of ${fmtTime(b.n / b.rate, 1e-6)} · drag to select · hover a bit to find it in the text`; }
    const us = (r[1] - r[0]) / b.rate * 1e6;
    return `selected ${fmtTime(us / 1e6, 1e-6)} · ${a.symUs ? (us / a.symUs).toFixed(1) : '—'} symbols at ${a.symUs.toFixed(1)} µs`;
  }

  /** Text of a panel, for the clipboard. */
  private copyText(b: AnBurst, what: string): string {
    const a = this.reading(b), pt = this.pulsesOf(b, a);
    if (what === 'pulses') return `${classCsv(pt)}\n\n${pulseCsv(pt)}`;
    if (what === 'frames') return framesCsv(frameSegments(a, b.rate));
    if (what === 'levels') { const lv = levels(a, b.env, b.fm, b.rate); return Object.entries(lv).filter(([k]) => k !== 'toneHist').map(([k, v]) => `${k},${typeof v === 'number' ? v.toFixed(3) : v}`).join('\n'); }
    if (what === 'demod') { const f = symbolFit(a, b.rate); return `modulation,${a.mod}\ncoding,${a.coding}\nsymbol_us,${a.symUs.toFixed(2)}\nsymbol_fit_error_pct,${f.errPct.toFixed(2)}\nbaud,${a.baud.toFixed(1)}\nshift_hz,${a.shiftHz.toFixed(0)}\nthreshold,${a.thr.toFixed(3)}`; }
    if (what === 'cursors') { const d = document.createElement('div'); d.innerHTML = this.cursorText(b, a); d.querySelectorAll('button').forEach(x => x.remove()); return d.textContent?.trim() ?? ''; }
    return '';
  }

  // ---- navigation ---------------------------------------------------------------------------------------------

  /** Show [a0, a1) (at least 16 samples, at most the burst), and remember it in the zoom history a moment later. */
  private setView(b: AnBurst, a0: number, a1: number, record = true): void {
    const len = Math.max(16, Math.min(b.n, a1 - a0));
    let s = Math.max(0, Math.min(b.n - len, a0));
    if (!Number.isFinite(s)) s = 0;
    this.zoom = [Math.round(s), Math.round(s + len)];
    if (record) this.remember();
  }
  private zoomAt(b: AnBurst, center: number, factor: number): void {
    const [a0, a1] = this.shown(b), len = (a1 - a0) * factor, f = (center - a0) / Math.max(1, a1 - a0);
    this.setView(b, center - f * len, center - f * len + len);
  }
  private remember(): void {
    clearTimeout(this.histTimer);
    this.histTimer = window.setTimeout(() => {
      const z = this.zoom ? [...this.zoom] as [number, number] : null;
      const cur = this.hist[this.histAt];
      if (cur !== undefined && JSON.stringify(cur) === JSON.stringify(z)) return;
      this.hist = this.hist.slice(0, this.histAt + 1); this.hist.push(z);
      if (this.hist.length > 50) this.hist.shift();
      this.histAt = this.hist.length - 1;
      this.navButtons();
    }, 400);
  }
  private navButtons(): void {
    const r = this.root;
    const bk = r?.querySelector<HTMLButtonElement>('[data-annav="back"]'), fw = r?.querySelector<HTMLButtonElement>('[data-annav="fwd"]'), sl = r?.querySelector<HTMLButtonElement>('[data-annav="sel"]');
    if (bk) bk.disabled = this.histAt <= 0;
    if (fw) fw.disabled = this.histAt >= this.hist.length - 1;
    if (sl) sl.disabled = !this.pick;
  }
  /** Redraw the trace, the strip and the readouts without rebuilding the view around them. */
  private repaint(b: AnBurst): void {
    const r = this.root;
    const cv = r?.querySelector<HTMLCanvasElement>('#an-canvas'), mini = r?.querySelector<HTMLCanvasElement>('#an-mini');
    if (cv) this.paint(cv, b);
    if (mini) { const [a0, a1] = this.shown(b); paintMini(mini, b, a0, a1, this.pick); }
    const a = this.reading(b);
    const cur = r?.querySelector<HTMLElement>('#an-cur'); if (cur) { cur.innerHTML = this.cursorText(b, a); this.wireCursorBar(cur, b); }
    const si = r?.querySelector<HTMLElement>('#an-selinfo'); if (si) si.textContent = this.selText(b, a).replace(/<[^>]+>/g, '');
    this.navButtons();
  }
  private wireCursorBar(el: HTMLElement, b: AnBurst): void {
    el.querySelector<HTMLButtonElement>('[data-annav="nocur"]')?.addEventListener('click', () => { this.cursors = [null, null]; this.repaint(b); });
    el.querySelector<HTMLButtonElement>('[data-ancopy]')?.addEventListener('click', (e) => this.copy(b, 'cursors', e.currentTarget as HTMLButtonElement));
  }
  private copy(b: AnBurst, what: string, btn: HTMLButtonElement): void {
    const text = this.copyText(b, what);
    void navigator.clipboard?.writeText(text).then(() => { btn.textContent = 'COPIED'; setTimeout(() => { btn.textContent = 'COPY'; }, 1200); }, () => { btn.textContent = 'NO CLIPBOARD'; });
  }

  private wireDetail(det: HTMLElement, b: AnBurst): void {
    det.querySelectorAll<HTMLButtonElement>('[data-anview]').forEach(x => x.onclick = () => { this.view = x.dataset.anview as View; this.draw(); });
    det.querySelectorAll<HTMLButtonElement>('[data-antool]').forEach(x => x.onclick = () => { this.tool = x.dataset.antool as Tool; this.draw(); });
    det.querySelectorAll<HTMLButtonElement>('[data-anfmt]').forEach(x => x.onclick = () => { this.fmt = x.dataset.anfmt as Fmt; this.draw(); });
    det.querySelectorAll<HTMLButtonElement>('[data-anmod]').forEach(x => x.onclick = () => this.setOver(b, o => { o.mod = x.dataset.anmod === 'AUTO' ? undefined : x.dataset.anmod as Mod; o.thr = undefined; }));
    det.querySelectorAll<HTMLButtonElement>('[data-ancoding]').forEach(x => x.onclick = () => this.setOver(b, o => { o.coding = x.dataset.ancoding === 'AUTO' ? undefined : x.dataset.ancoding as Coding; }));
    det.querySelectorAll<HTMLElement>('details[data-ansec]').forEach(d => d.addEventListener('toggle', () => { const id = d.dataset.ansec!; if ((d as HTMLDetailsElement).open) this.openSec.add(id); else this.openSec.delete(id); if (id === 'pulses' && (d as HTMLDetailsElement).open) { const hc = det.querySelector<HTMLCanvasElement>('#an-hist'); if (hc) paintHistogram(hc, this.reading(b), b.rate, this.pulsesOf(b, this.reading(b))); } }));
    det.querySelectorAll<HTMLButtonElement>('summary [data-ancopy]').forEach(x => x.onclick = (e) => { e.preventDefault(); e.stopPropagation(); this.copy(b, x.dataset.ancopy!, x); });
    const thr = det.querySelector<HTMLInputElement>('#an-thr');
    if (thr) { thr.oninput = () => { const pct = det.querySelector('.an-pct'); if (pct) pct.textContent = `${thr.value}%`; }; thr.onchange = () => this.setOver(b, o => { o.thr = +thr.value / 100; }); }
    const nm = det.querySelector<HTMLInputElement>('#an-nm'), nt = det.querySelector<HTMLTextAreaElement>('#an-nt');
    if (nm) nm.onchange = () => { b.name = nm.value.trim(); this.save(b); this.draw(false); };
    if (nt) nt.onchange = () => { b.note = nt.value.trim(); this.save(b); this.draw(false); };
    det.querySelectorAll<HTMLButtonElement>('[data-annav]').forEach(x => x.onclick = () => {
      const [a0, a1] = this.shown(b), mid = (a0 + a1) / 2;
      switch (x.dataset.annav) {
        case 'in': this.zoomAt(b, mid, 0.5); break;
        case 'out': this.zoomAt(b, mid, 2); break;
        case 'fit': this.zoom = null; this.remember(); break;
        case 'full': this.setView(b, 0, b.n); break;
        case 'sel': if (this.pick) { this.setView(b, this.pick[0], this.pick[1]); this.pick = null; } break;
        case 'back': if (this.histAt > 0) { this.histAt--; this.zoom = this.hist[this.histAt]; } break;
        case 'fwd': if (this.histAt < this.hist.length - 1) { this.histAt++; this.zoom = this.hist[this.histAt]; } break;
        case 'yup': this.yz[this.view] = Math.min(64, this.yz[this.view] * 2); this.draw(); return;
        case 'ydn': this.yz[this.view] = Math.max(1, this.yz[this.view] / 2); this.draw(); return;
        case 'yauto': this.yz[this.view] = 1; this.draw(); return;
        case 'axis': this.samplesAxis = !this.samplesAxis; this.draw(); return;
        case 'dur': this.showDur = !this.showDur; this.draw(); return;
        case 'clock': this.showClock = !this.showClock; this.draw(); return;
        case 'nocur': this.cursors = [null, null]; break;
      }
      this.repaint(b);
    });
    det.querySelectorAll<HTMLButtonElement>('[data-ando]').forEach(x => x.onclick = () => {
      const a = this.reading(b);
      switch (x.dataset.ando) {
        case 'close': this.close(); break;
        case 'star': b.star = !b.star; this.save(b); this.draw(); break;
        case 'back': this.back(); break;
        case 'compare': this.cmpTx = 0; this.comparing = true; this.fields = []; this.check = null; this.colPick = null; this.draw(); break;
        case 'sym-': this.setOver(b, o => { o.symUs = a.symUs / 1.05; }); break;
        case 'sym+': this.setOver(b, o => { o.symUs = a.symUs * 1.05; }); break;
        case 'symauto': this.setOver(b, o => { o.symUs = undefined; }); break;
        case 'thrauto': this.setOver(b, o => { o.thr = undefined; }); break;
        case 'invert': this.setOver(b, o => { o.invert = o.invert ? undefined : true; }); break;
        case 'selonly': this.selOnly = !this.selOnly; this.draw(); break;
        case 'cu8': save(exportName(b.center + b.hz, b.rate, b.id, 'cu8'), toCu8(b.iq)); break;
        case 'cs8': save(exportName(b.center + b.hz, b.rate, b.id, 'cs8'), toCs8(b.iq)); break;
        case 'sub': save(exportName(b.center + b.hz, b.rate, b.id, 'sub'), new TextEncoder().encode(this.subOf(b, a))); break;
        case 'csv': {
          const [s0, s1] = this.pick ?? this.shown(b), pt = this.pulsesOf(b, a);
          const text = selectionCsv({ samples: samplesCsv(b.iq, b.env, b.fm, b.rate, s0, s1), pulses: pulseCsv({ ...pt, pulses: pt.pulses.filter(p => p.start + p.n > s0 && p.start < s1) }), classes: classCsv(pt), frames: framesCsv(frameSegments(a, b.rate)) });
          save(exportName(b.center + b.hz, b.rate, b.id, 'csv').replace('.csv', `_${s0}-${s1}.csv`), new TextEncoder().encode(text));
          break;
        }
        case 'tx': this.opened = false; this.host.sendToTx(this.subOf(b, a), b.center ? b.center + b.hz : this.host.center() + b.hz, a.mod === 'FSK'); break;
      }
    });
    const cv = det.querySelector<HTMLCanvasElement>('#an-canvas');
    if (cv) { this.paint(cv, b); this.wireTrace(cv, b); }
    const mini = det.querySelector<HTMLCanvasElement>('#an-mini');
    if (mini) { const [a0, a1] = this.shown(b); paintMini(mini, b, a0, a1, this.pick); this.wireMini(mini, b); }
    const hc = det.querySelector<HTMLCanvasElement>('#an-hist');
    if (hc) paintHistogram(hc, this.reading(b), b.rate, this.pulsesOf(b, this.reading(b)));
    const cur = det.querySelector<HTMLElement>('#an-cur');
    if (cur) this.wireCursorBar(cur, b);
    const out = det.querySelector<HTMLElement>('#an-out');
    if (out && cv) this.wireOut(out, cv, b);
  }

  /** The overview strip: drag the box to pan, click elsewhere to jump there. */
  private wireMini(cv: HTMLCanvasElement, b: AnBurst): void {
    let drag = false, off = 0;
    const at = (e: PointerEvent) => { const r = cv.getBoundingClientRect(); return (e.clientX - r.left) / r.width * b.n; };
    cv.onpointerdown = (e) => {
      const s = at(e), [a0, a1] = this.shown(b);
      cv.setPointerCapture(e.pointerId); drag = true;
      if (s < a0 || s > a1) { this.setView(b, s - (a1 - a0) / 2, s + (a1 - a0) / 2, false); off = (a1 - a0) / 2; } else off = s - a0;
      this.repaint(b);
    };
    cv.onpointermove = (e) => { if (!drag) return; const [a0, a1] = this.shown(b); const s = at(e) - off; this.setView(b, s, s + (a1 - a0), false); this.repaint(b); };
    cv.onpointerup = () => { if (drag) { drag = false; this.remember(); } };
  }

  /** The frames as text, every character tagged with the frame and bits it stands for. */
  private outHtml(a: Analysis): string {
    if (!a.frames.length) return '<div class="mt-wait">no frames: set the modulation, symbol or cut by hand, or select the part that carries data</div>';
    const per = this.fmt === 'bits' ? 1 : this.fmt === 'hex' ? 4 : 8;
    return a.frames.slice(0, 60).map((f, i) => {
      const text = this.fmt === 'bits' ? f.bits : this.fmt === 'hex' ? bitsToHex(f.bits) : bitsToAscii(f.bits);
      let body = '';
      for (let j = 0; j < text.length; j++) body += `<i data-c="${i}:${j * per}:${Math.min(f.bits.length, (j + 1) * per)}">${esc(text[j])}</i>${this.fmt === 'bits' && j % 8 === 7 ? ' ' : this.fmt === 'hex' && j % 2 === 1 ? ' ' : ''}`;
      return `<div class="an-frame"><b>${i + 1}</b><em>${f.bits.length}</em><span>${body}</span></div>`;
    }).join('');
  }

  private setOver(b: AnBurst, f: (o: Overrides) => void): void {
    const o = { ...b.over }; f(o);
    for (const k of Object.keys(o) as (keyof Overrides)[]) if (o[k] === undefined) delete o[k];
    b.over = o; this.save(b); this.hl = null;
    this.draw();
  }

  private subOf(b: AnBurst, a: Analysis): string { return toSub(pulsesUs(a, b.rate), b.center ? b.center + b.hz : 433_920_000, a.mod === 'FSK', a.shiftHz); }

  /** The bit (frame, index) whose span holds sample `i`, if any. */
  private bitAt(a: Analysis, i: number): { f: number; b: number } | null {
    for (let f = 0; f < a.frames.length; f++) {
      const s = a.frames[f].spans;
      if (!s.length || i < s[0] || i >= s[s.length - 1]) continue;
      let lo = 0, hi = (s.length >> 1) - 1;
      while (lo < hi) { const m = (lo + hi + 1) >> 1; if (s[2 * m] <= i) lo = m; else hi = m - 1; }
      if (i < s[2 * lo + 1]) return { f, b: lo };
    }
    return null;
  }

  /**
   * The trace's pointer: the wheel (or a trackpad pinch) zooms around the pointer, Shift+wheel pans, Alt+wheel zooms
   * vertically; two fingers pinch and pan; one pointer selects, measures or pans by the tool; hovering draws the
   * crosshair and finds the bit under it.
   */
  private wireTrace(cv: HTMLCanvasElement, b: AnBurst): void {
    const dpr = window.devicePixelRatio || 1;
    const pts = new Map<number, { x: number; y: number }>();
    let mode: 'none' | 'select' | 'pan' | 'cursor' | 'pinch' = 'none';
    let from = -1, cur = 0, panX = 0, panWin: [number, number] = [0, 0], pinchD = 0, pinchWin: [number, number] = [0, 0], pinchMid = 0, pinchX = 0, downX = 0;
    const sampleAt = (clientX: number) => { const r = cv.getBoundingClientRect(), [a0, a1] = this.shown(b); return a0 + Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * (a1 - a0); };
    const twoFinger = () => { const [p, q] = [...pts.values()]; return { d: Math.hypot(p.x - q.x, p.y - q.y), mid: (p.x + q.x) / 2 }; };
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = cv.getBoundingClientRect(), [a0, a1] = this.shown(b);
      if (e.altKey) { this.yz[this.view] = Math.max(1, Math.min(64, this.yz[this.view] * (e.deltaY < 0 ? 2 : 0.5))); this.repaint(b); return; }
      const sideways = e.shiftKey ? e.deltaY || e.deltaX : Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : 0;
      if (sideways) { const s = sideways / r.width * (a1 - a0); this.setView(b, a0 + s, a1 + s); }
      else this.zoomAt(b, sampleAt(e.clientX), Math.exp(Math.max(-2, Math.min(2, e.deltaY * (e.deltaMode ? 0.05 : 0.0025)))));
      this.repaint(b);
    }, { passive: false });
    cv.onpointerdown = (e) => {
      cv.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      downX = e.clientX;
      if (pts.size === 2) { mode = 'pinch'; const t = twoFinger(); pinchD = t.d; pinchX = t.mid; pinchMid = sampleAt(t.mid); pinchWin = this.shown(b); this.pick = null; return; }
      if (pts.size > 2) return;
      if (e.shiftKey || this.tool === 'pan' || e.button === 1) { mode = 'pan'; panX = e.clientX; panWin = this.shown(b); return; }
      const s = Math.round(sampleAt(e.clientX));
      if (this.tool === 'measure') {
        mode = 'cursor';
        const [A, B] = this.cursors, r = cv.getBoundingClientRect(), [a0, a1] = this.shown(b), px = (v: number) => (v - a0) / (a1 - a0) * r.width;
        cur = A === null ? 0 : B === null ? 1 : Math.abs(px(A) - (e.clientX - r.left)) <= Math.abs(px(B) - (e.clientX - r.left)) ? 0 : 1;
        this.cursors[cur] = s; this.repaint(b);
        return;
      }
      mode = 'select'; from = s;
    };
    cv.onpointermove = (e) => {
      const r = cv.getBoundingClientRect();
      if (pts.has(e.pointerId)) pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (mode === 'pinch' && pts.size >= 2) {
        const t = twoFinger(), len = (pinchWin[1] - pinchWin[0]) * pinchD / Math.max(10, t.d);
        const f = (pinchX - r.left) / r.width, s = pinchMid - f * len - (t.mid - pinchX) / r.width * len;
        this.setView(b, s, s + len, false); this.repaint(b);
        return;
      }
      if (mode === 'pan') { const s = -(e.clientX - panX) / r.width * (panWin[1] - panWin[0]); this.setView(b, panWin[0] + s, panWin[1] + s, false); this.repaint(b); return; }
      if (mode === 'cursor') { this.cursors[cur] = Math.round(sampleAt(e.clientX)); this.repaint(b); return; }
      const i = Math.round(sampleAt(e.clientX));
      this.hover = { x: (e.clientX - r.left) * (cv.width / r.width), y: (e.clientY - r.top) * (cv.height / r.height) };
      if (mode === 'none') {
        const hit = this.bitAt(this.reading(b), i);
        const next = hit ? { f: hit.f, b0: hit.b, b1: hit.b + 1 } : null;
        if (JSON.stringify(next) !== JSON.stringify(this.hl)) { this.hl = next; this.markOut(); }
        this.paint(cv, b);
        return;
      }
      this.pick = i === from ? null : [Math.min(from, i), Math.max(from, i)];
      this.paint(cv, b);
      const si = this.root?.querySelector<HTMLElement>('#an-selinfo'); if (si) si.textContent = this.selText(b, this.reading(b));
    };
    const up = (e: PointerEvent) => {
      pts.delete(e.pointerId);
      if (mode === 'pinch') { if (pts.size < 2) { mode = pts.size ? 'none' : 'none'; this.remember(); } return; }
      if (mode === 'pan') { mode = 'none'; this.remember(); return; }
      if (mode === 'cursor') { mode = 'none'; return; }
      if (mode !== 'select') return;
      mode = 'none';
      const tap = Math.abs(e.clientX - downX) < 4 * Math.max(1, dpr / 2);
      if (tap) {
        // a tap lights the bit under it (on touch there is no hover to do it)
        this.pick = null;
        const hit = this.bitAt(this.reading(b), Math.round(sampleAt(e.clientX)));
        this.hl = hit ? { f: hit.f, b0: hit.b, b1: hit.b + 1 } : null;
        this.markOut(); this.repaint(b);
        return;
      }
      if (this.pick && this.pick[1] - this.pick[0] < 4) this.pick = null;
      this.repaint(b);
    };
    cv.onpointerup = up;
    cv.onpointercancel = up;
    cv.onpointerleave = () => { if (mode === 'none') { this.hover = null; if (this.hl) { this.hl = null; this.markOut(); } this.paint(cv, b); } };
    cv.ondblclick = () => { this.zoom = null; this.remember(); this.repaint(b); };
  }

  /** The text side of the link: hover a character to light its bits on the trace, drag across characters to select their samples. */
  private wireOut(out: HTMLElement, cv: HTMLCanvasElement, b: AnBurst): void {
    const parse = (el: Element | null) => { const c = (el as HTMLElement | null)?.closest<HTMLElement>('[data-c]')?.dataset.c; if (!c) return null; const [f, b0, b1] = c.split(':').map(Number); return { f, b0, b1 }; };
    let down: { f: number; b0: number; b1: number } | null = null;
    out.onpointermove = (e) => {
      const h = parse(e.target as Element);
      if (!h) return;
      if (down && down.f === h.f) this.hl = { f: h.f, b0: Math.min(down.b0, h.b0), b1: Math.max(down.b1, h.b1) };
      else if (!down) this.hl = h;
      else return;
      this.paint(cv, b); this.markOut();
    };
    out.onpointerdown = (e) => { down = parse(e.target as Element); if (down) { this.hl = down; e.preventDefault(); this.paint(cv, b); this.markOut(); } };
    out.onpointerup = () => {
      if (down && this.hl) {
        const s = this.reading(b).frames[this.hl.f]?.spans;
        if (s && s.length) {
          this.pick = [s[2 * this.hl.b0], s[2 * (this.hl.b1 - 1) + 1]];
          // bring the bits into view if the trace is zoomed elsewhere
          const [z0, z1] = this.shown(b);
          if (this.pick[0] < z0 || this.pick[1] > z1) this.zoom = null;
          this.paint(cv, b);
          const z = this.root?.querySelector<HTMLButtonElement>('[data-ando="zoom"]'); if (z) z.disabled = false;
        }
      }
      down = null;
    };
    out.onpointerleave = () => { if (!down && this.hl) { this.hl = null; this.paint(cv, b); this.markOut(); } };
  }

  /** Light the characters that stand for the highlighted bits. */
  private markOut(): void {
    const out = this.root?.querySelector('#an-out');
    if (!out) return;
    out.querySelectorAll('i.hl').forEach(e => e.classList.remove('hl'));
    const h = this.hl;
    if (!h) return;
    out.querySelectorAll<HTMLElement>(`[data-c^="${h.f}:"]`).forEach(e => { const [, b0, b1] = e.dataset.c!.split(':').map(Number); if (b0 < h.b1 && b1 > h.b0) e.classList.add('hl'); });
    out.querySelector('i.hl')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  // ---- compare ------------------------------------------------------------------------------------------------

  /** The bursts that read like the selected one: the comparison's candidates, in time order. */
  private group(): AnBurst[] {
    const b = this.selected();
    if (this.cmpTx) {
      // the press's frames that read like its main one (an FSK key's bare carriers read as something else)
      const t = this.txs().find(x => x.id === this.cmpTx);
      if (t) {
        const sum = t.members.filter(x => x.best).map(x => ({ x, mod: x.auto.mod, coding: x.auto.coding, symUs: x.auto.symUs, bits: x.best.length }));
        const me = sum.find(q => q.x === repOf(t));
        return me ? similar(sum, me).map(q => q.x) : sum.map(q => q.x);
      }
    }
    if (!b || !b.best) return [];
    const sum = this.bursts.filter(x => x.best).map(x => ({ x, mod: x.auto.mod, coding: x.auto.coding, symUs: x.auto.symUs, bits: x.best.length }));
    const me = sum.find(s => s.x.id === b.id)!;
    return similar(sum, me).map(s => s.x);
  }

  private compareHtml(b: AnBurst): string {
    const cands = this.group();
    const rows = cands.filter(x => !this.left.has(x.id) || x.id === b.id);
    const head = `<div class="an-head"><b>COMPARE</b><span>${rows.length} of ${cands.length} frame${cands.length === 1 ? '' : 's'} ${this.cmpTx ? 'of this transmission' : `like burst ${b.id}`} · ${b.auto.mod} · ${b.auto.coding} · ${b.auto.symUs.toFixed(0)} µs</span>`
      + `<button class="chip" data-ando="suggest">SUGGEST</button><button class="chip" data-ando="saveproto" ${this.fields.length ? '' : 'disabled'}>SAVE AS PROTOCOL</button><button class="chip ${this.showProtocols ? 'on' : ''}" data-ando="protocols">PROTOCOLS ${this.protocols.length}</button><button class="chip" data-ando="back">BACK</button><button class="chip" data-ando="close">✕</button></div>`;
    const inout = `<div class="an-sub">FRAMES · TAP TO LEAVE ONE OUT</div><div class="an-inout">${cands.map(x => `<button class="chip ${this.left.has(x.id) && x.id !== b.id ? '' : 'on'}" data-anin="${x.id}">${x.id}${x.name ? ` ${esc(x.name)}` : ''}</button>`).join('')}</div>`;
    const protos = this.showProtocols ? `<div class="an-protos">${this.protocols.length ? this.protocols.map((p, i) => `<div><b>${esc(p.name)}</b><span>${p.mod} · ${p.coding} · sync ${bitsToHex(p.sync)} · ${p.fields.length} fields${p.check ? ` · ${esc(p.check.name.split(' (')[0])}` : ''} · ${this.bursts.filter(x => x.proto?.protocol === p).length} heard</span><button class="chip" data-anprn="${i}">RENAME</button><button class="chip" data-anprd="${i}">DELETE</button></div>`).join('') : '<div class="mt-wait">no saved protocols yet: SUGGEST or drag out fields here, then SAVE AS PROTOCOL</div>'}</div>` : '';
    if (rows.length < 2) return head + `<div class="an-scroll">${protos}${inout}<div class="mt-wait">capture the same button a few more times: frames that read alike are lined up here</div></div>`;
    return head + `<div class="an-scroll an-cmp">${protos}${this.alignedHtml(align(rows.map(x => x.best)), rows, b.id)}${inout}</div>`;
  }

  private alignedHtml(al: Alignment, rows: AnBurst[], selId: number): string {
    const pre = al.preamble, sync = al.sync;
    const start = dataStart(al);
    const sum = `${rows.length} frames · ${pre ? `preamble ${pre[1] - pre[0]} bits · ` : ''}${sync ? `sync ${sync.hex} · ` : ''}${al.fixedBits} fixed · ${al.changingBits} changing`;
    const total = Math.max(1, al.segments.reduce((n, s) => n + s.to - s.from, 0));
    const bar = al.segments.map(s => `<i class="${s.fixed ? 'f' : 'c'}" style="flex:${s.to - s.from}" title="${s.fixed ? 'fixed' : 'changing'} ${s.to - s.from} bits"><b>${s.to - s.from > total / 40 ? s.to - s.from : ''}</b></i>`).join('');
    // the field bar: each field a colored stretch over its columns, named where it fits
    const kindAt = new Array<number>(al.width).fill(-1);
    this.fields.forEach((f, i) => { for (let c = start + f.from; c < start + f.to; c++) if (c >= 0 && c < al.width) kindAt[c] = i; });
    let fbar = '';
    for (let c = 0; c < al.width;) {
      let e = c; while (e < al.width && kindAt[e] === kindAt[c]) e++;
      const f = kindAt[c] >= 0 ? this.fields[kindAt[c]] : null;
      fbar += `<span style="width:${e - c}ch;${f ? `background:${KIND_COLOR[f.kind]}` : ''}" title="${f ? esc(`${f.name} (${f.kind}), bits ${f.from}–${f.to}`) : ''}">${f && e - c >= Math.ceil(f.name.length * 0.75) + 1 ? `<small>${esc(f.name)}</small>` : ''}</span>`;
      c = e;
    }
    const cls = (c: number) => (al.state[c] === 1 ? 'f' : al.state[c] === 0 ? 'c' : 'u');
    const tag = (k: string) => (k === 'f' ? 'em' : k === 'c' ? 'strong' : 'u');
    const line = (bits: string, shift: number) => {
      let out = '<u>' + ' '.repeat(shift) + '</u>';
      let run = '', k = '';
      for (let j = 0; j < bits.length; j++) {
        const c = cls(shift + j);
        if (c !== k && run) { out += `<${tag(k)}>${run}</${tag(k)}>`; run = ''; }
        k = c; run += bits[j];
      }
      if (run) out += `<${tag(k)}>${run}</${tag(k)}>`;
      return out;
    };
    let ruler = '';
    for (let c = 0; c < al.width; c++) ruler += pre && c >= pre[0] && c < pre[1] ? 'P' : sync && c >= sync.from && c < sync.to ? 'S' : c >= start && (c - start) % 8 === 0 ? '|' : ' ';
    const pickLine = this.colPick ? ' '.repeat(this.colPick[0]) + '▔'.repeat(Math.max(1, this.colPick[1] - this.colPick[0])) : ' ';
    const body = al.rows.map(r => { const x = rows[r.index]; return `<div class="${x.id === selId ? 'me' : ''}"><b>${x.id}</b><code>${line(r.bits, r.shift)}</code></div>`; }).join('');
    let bytes = '';
    for (let c = start; c + 8 <= al.width; c += 8) {
      let fixed = true; for (let k = 0; k < 8; k++) if (al.state[c + k] !== 1) fixed = false;
      bytes += `<span class="${fixed ? 'f' : 'c'}">${fixed ? parseInt(al.consensus.slice(c, c + 8), 2).toString(16).toUpperCase().padStart(2, '0') : '··'}</span>`;
    }
    const chips = this.fields.map((f, i) => `<button class="chip an-fchip" data-anfd="${i}" style="border-color:${KIND_COLOR[f.kind]}" title="tap to delete"><i style="background:${KIND_COLOR[f.kind]}"></i>${esc(f.name)} <small>${f.from}–${f.to}</small> ✕</button>`).join('');
    const form = this.colPick ? `<div class="an-ctl an-newf"><span class="rl">NEW FIELD</span><span class="an-dim">bits ${this.colPick[0] - start}–${this.colPick[1] - start}</span><input id="an-fname" class="txin" maxlength="30" placeholder="name"><select id="an-fkind" class="txin">${FIELD_KINDS.map(k => `<option value="${k}">${k}</option>`).join('')}</select><button class="chip primary" data-ando="addfield">ADD</button><button class="chip" data-ando="nopick">CANCEL</button></div>` : '';
    const chk = this.check ? `<div class="an-why an-check">CHECK: ${esc(this.check.name)} over bytes ${this.check.from}–${this.check.to - 1}, stored at byte ${this.check.at}${this.check.spec.width === 16 ? (this.check.little ? ' (low byte first)' : ' (high byte first)') : ''} ✓ on every frame</div>` : '';
    return `<div class="an-why">${esc(sum)}</div><div class="an-segbar">${bar}</div>`
      + `<div class="an-bytes"><b>BYTES FROM THE ${sync ? 'SYNC WORD' : pre ? 'END OF THE PREAMBLE' : 'FIRST SHARED BIT'}</b>${bytes}</div>${chk}`
      + `<div class="an-fchips">${chips || '<span class="an-dim">no fields yet: SUGGEST, or drag across the bits below to mark one</span>'}</div>${form}`
      + `<div class="an-align" id="an-align"><div class="fbar"><b></b><code>${fbar}</code></div><div class="ruler"><b></b><code>${ruler.replace(/ /g, '&nbsp;')}</code></div><div class="pick"><b></b><code>${pickLine.replace(/ /g, '&nbsp;')}</code></div>${body}</div>`
      + `<div class="an-legend"><em>fixed</em> <strong>changing</strong> <u>one frame only</u> · drag across columns to name a field</div>`;
  }

  private wireCompare(det: HTMLElement, b: AnBurst): void {
    const rows = this.group().filter(x => !this.left.has(x.id) || x.id === b.id);
    const al = rows.length >= 2 ? align(rows.map(x => x.best)) : null;
    det.querySelectorAll<HTMLButtonElement>('[data-anin]').forEach(x => x.onclick = () => { const id = +x.dataset.anin!; if (id !== b.id && !this.left.delete(id)) this.left.add(id); this.draw(); });
    det.querySelectorAll<HTMLButtonElement>('[data-anfd]').forEach(x => x.onclick = () => { this.fields.splice(+x.dataset.anfd!, 1); this.draw(); });
    det.querySelectorAll<HTMLButtonElement>('[data-anprd]').forEach(x => x.onclick = () => { const i = +x.dataset.anprd!; if (!confirm(`Delete the protocol "${this.protocols[i].name}"?`)) return; this.protocols.splice(i, 1); this.saveProtocols(); this.recognizeAll(); this.draw(); });
    det.querySelectorAll<HTMLButtonElement>('[data-anprn]').forEach(x => x.onclick = () => { const p = this.protocols[+x.dataset.anprn!]; const n = prompt('Protocol name', p.name)?.trim(); if (!n) return; p.name = n; this.saveProtocols(); this.draw(); });
    det.querySelectorAll<HTMLButtonElement>('[data-ando]').forEach(x => x.onclick = () => {
      switch (x.dataset.ando) {
        case 'close': this.close(); break;
        case 'back': this.back(); break;
        case 'protocols': this.showProtocols = !this.showProtocols; this.draw(); break;
        case 'suggest': if (al) { const s = suggest(al); this.fields = s.fields; this.check = s.check; } this.draw(); break;
        case 'nopick': this.colPick = null; this.draw(); break;
        case 'addfield': {
          if (!al || !this.colPick) break;
          const start = dataStart(al), kind = det.querySelector<HTMLSelectElement>('#an-fkind')!.value as FieldKind;
          const name = det.querySelector<HTMLInputElement>('#an-fname')!.value.trim() || kind;
          this.fields.push({ name, kind, from: this.colPick[0] - start, to: this.colPick[1] - start });
          this.fields.sort((p, q) => p.from - q.from); this.colPick = null; this.draw();
          break;
        }
        case 'saveproto': {
          if (!al || !this.fields.length) break;
          const sf = this.fields.find(f => f.kind === 'sync'), start = dataStart(al);
          const syncBits = sf ? al.consensus.slice(start + sf.from, start + sf.to) : al.sync?.bits ?? '';
          if (syncBits.length < 8) { alert('Mark a sync word of at least 8 bits first: it is how the protocol is recognized.'); break; }
          const name = prompt('Name this protocol', b.name || 'my remote')?.trim();
          if (!name) break;
          // fields are counted from the data start; a sync field of the person's own may start elsewhere, so the
          // whole set moves to count from it (which is where recognize() will find the data start)
          const base = sf ? sf.from : 0;
          this.protocols.push({ name, sync: syncBits, mod: b.auto.mod, coding: b.auto.coding, symUs: b.auto.symUs, fields: this.fields.map(f => ({ ...f, from: f.from - base, to: f.to - base })), check: this.check && !base ? this.check : undefined });
          this.saveProtocols(); this.recognizeAll(); this.showProtocols = true; this.draw();
          break;
        }
      }
    });
    // drag across the bits to pick columns for a new field
    const box = det.querySelector<HTMLElement>('#an-align');
    if (!box || !al) return;
    const colAt = (e: PointerEvent) => {
      const code = box.querySelector<HTMLElement>('.ruler code');
      if (!code) return -1;
      const r = code.getBoundingClientRect(), ch = r.width / Math.max(1, al.width);
      return Math.max(0, Math.min(al.width - 1, Math.floor((e.clientX - r.left) / ch)));
    };
    let from = -1;
    box.onpointerdown = (e) => { if ((e.target as HTMLElement).closest('b')) return; from = colAt(e); if (from >= 0) { box.setPointerCapture(e.pointerId); e.preventDefault(); } };
    box.onpointermove = (e) => {
      if (from < 0) return;
      const c = colAt(e);
      this.colPick = [Math.min(from, c), Math.max(from, c) + 1];
      const p = box.querySelector('.pick code');
      if (p) p.innerHTML = (' '.repeat(this.colPick[0]) + '▔'.repeat(this.colPick[1] - this.colPick[0])).replace(/ /g, '&nbsp;');
    };
    box.onpointerup = () => {
      if (from < 0) return;
      from = -1;
      if (this.colPick && this.colPick[1] - this.colPick[0] < 2) this.colPick = null;
      const sx = box.scrollLeft;
      this.draw();
      const nb = this.root?.querySelector<HTMLElement>('#an-align'); if (nb) nb.scrollLeft = sx;
      this.root?.querySelector<HTMLInputElement>('#an-fname')?.focus();
    };
  }

  // ---- sessions -----------------------------------------------------------------------------------------------

  private exportSession(): void {
    if (!this.bursts.length && !this.protocols.length) { this.flash('NOTHING TO EXPORT YET'); return; }
    const meta = {
      version: 1, app: 'Mayhem Analyzer', saved: new Date().toISOString(), protocols: this.protocols,
      bursts: this.bursts.map(b => ({ id: b.id, t: b.t, wall: b.wall, hz: b.hz, rate: b.rate, n: b.n, ms: b.ms, dbfs: b.dbfs, snr: b.snr, matches: b.matches, src: b.src, center: b.center, name: b.name, star: b.star, note: b.note, over: b.over })),
    };
    const d = new Date();
    save(`analyzer_session_${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}_${two(d.getHours())}${two(d.getMinutes())}.mmanalyzer`, encodeBundle(meta, this.bursts.map(b => ({ env: b.env, fm: b.fm, iq: b.iq }))));
  }

  private importSession(bytes: Uint8Array, name: string): void {
    const s = decodeBundle(bytes);
    if (!s) { this.flash(`${name} IS NOT A SESSION FILE`); return; }
    let n = 0;
    for (let i = 0; i < s.meta.bursts.length; i++) {
      const m = s.meta.bursts[i] as unknown as AnBurst, arr = s.arrays[i];
      const auto = analyze(arr.env, arr.fm, m.n, m.rate);
      const b: AnBurst = { ...m, ...arr, id: ++this.lastId, matches: m.matches ?? [], name: m.name ?? '', star: !!m.star, note: m.note ?? '', over: m.over ?? {}, auto, best: bestOf(auto), seenAt: 0, proto: null };
      this.bursts.push(b); this.save(b); n++;
    }
    const ps = (s.meta.protocols ?? []) as Protocol[];
    for (const p of ps) if (!this.protocols.some(q => q.name === p.name && q.sync === p.sync)) this.protocols.push(p);
    this.saveProtocols(); this.recognizeAll(); this.trim();
    this.draw();
    this.flash(`${n} BURST${n === 1 ? '' : 'S'} AND ${ps.length} PROTOCOL${ps.length === 1 ? '' : 'S'} FROM ${name}`);
  }

  // ---- the waveform -------------------------------------------------------------------------------------------

  /** Samples well inside the carrier, once per burst: what the frequency view draws at full strength. */
  private innerOf(b: AnBurst): Uint8Array {
    let m = this.innerCache.get(b.id);
    if (!m) { m = innerMask(b.n, carrierOf(b.env, b.n, noiseOf(b.env, b.n, b.rate))); this.innerCache.set(b.id, m); if (this.innerCache.size > 20) this.innerCache.delete(this.innerCache.keys().next().value!); }
    return m;
  }

  private paint(cv: HTMLCanvasElement, b: AnBurst): void {
    const [a0, a1] = this.shown(b), a = this.reading(b);
    paintTrace(cv, {
      b, a, view: this.view, a0, a1, yz: this.yz[this.view], pick: this.pick, hl: this.hl, cursors: this.cursors, hover: this.hover,
      showDur: this.showDur, showClock: this.showClock, samplesAxis: this.samplesAxis, inner: this.innerOf(b), pulses: this.pulsesOf(b, a),
    });
  }
}

/** The frame a transmission is best shown by: the one most of its copies agree with (ties: the strongest). */
function repOf(t: Tx): AnBurst {
  let best = t.members[0], bestN = -1;
  for (const m of t.members) {
    if (!m.best) continue;
    const n = t.members.filter(x => x !== m && sameFrame(x.best, m.best)).length;
    if (n > bestN || (n === bestN && m.snr > best.snr)) { best = m; bestN = n; }
  }
  return best;
}
function bestOf(a: Analysis): string { return a.frames.reduce((s, f) => (f.bits.length > s.length ? f.bits : s), ''); }
function sameFilter(a: CaptureFilter, b: CaptureFilter): boolean { return (Object.keys(a) as (keyof CaptureFilter)[]).every(k => a[k] === b[k]); }


/** The card glyph: a pulse train. */
const WAVE_GLYPH = '<svg viewBox="0 0 24 24"><path d="M2 17h3V7h3.5v10H11V7h1.8v10h3V7H20v10h2"/></svg>';

function save(name: string, bytes: Uint8Array): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}
