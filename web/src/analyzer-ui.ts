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

import { fft, hann } from './fft.js';
import type { Scope, ScopeMark } from './scope.js';
import { analyze, carrierOf, noiseOf, bitsToAscii, bitsToHex, histogram, pulsesUs, CODINGS, FM_SCALE, MODS, type Analysis, type Coding, type Mod, type Overrides } from './dsp/analyzer/demod.js';
import { align, similar, type Alignment } from './dsp/analyzer/align.js';
import { decodeBundle, encodeBundle, exportName, freqFromName, toCs8, toCu8, toSub } from './dsp/analyzer/files.js';
import { checkHolds, dataStart, fieldValue, recognize, suggest, FIELD_KINDS, type CheckFound, type Field, type FieldKind, type Protocol } from './dsp/analyzer/fields.js';
import { NO_FILTER, passes, type Burst, type CaptureFilter } from './dsp/analyzer/capture.js';
import { groupPresses, sameFrame, type Transmission } from './dsp/analyzer/group.js';
import { store, type StoredBurst } from './analyzer-store.js';

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

type View = 'amp' | 'freq' | 'iq' | 'spec';
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
    if (id !== this.sel) { this.sel = id; this.zoom = this.pick = null; this.hl = null; }
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
    return Object.keys(o).length ? analyze(b.env, b.fm, b.n, b.rate, o) : b.auto;
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
    const r = this.pick ?? this.zoom;
    const selTxt = r ? `${((r[1] - r[0]) / b.rate * 1000).toFixed(3)} ms · ${((r[1] - r[0]) / b.rate * 1e6 / Math.max(1, a.symUs)).toFixed(1)} symbols` : 'drag across the trace to select · hover a bit to find it in the text';
    const why = `${a.mod} (${esc(a.why)}) · ${a.coding} · symbol ${a.symUs.toFixed(1)} µs · ${rateLabel(a.baud)}${a.mod === 'FSK' ? ` · shift ${(a.shiftHz / 1e3).toFixed(1)} kHz` : ''}`;
    const proto = b.proto;
    const fieldsHtml = proto ? (() => {
      const p = proto.protocol, ok = checkHolds(p, b.best, proto.start);
      return `<div class="an-sub">◆ ${esc(p.name.toUpperCase())}${ok === null ? '' : ok ? ' · CHECK ✓' : ' · CHECK ✗'}</div><div class="an-fields">${p.fields.map(f => `<div><i style="background:${KIND_COLOR[f.kind]}"></i><b>${esc(f.name)}</b><span>${esc(fieldValue(b.best, proto.start, f))}</span></div>`).join('')}</div>`;
    })() : '';
    return `<div class="an-head"><b>${esc(hz)}</b><span>${b.name ? `<em class="an-name">${esc(b.name)}</em> · ` : ''}${b.src ? esc(b.src) + ' · +' + b.t.toFixed(3) + ' s' : clock(b.wall)} · ${b.ms.toFixed(1)} ms · ${b.snr.toFixed(0)} dB SNR</span>`
      + `<button class="chip an-starbtn ${b.star ? 'on' : ''}" data-ando="star" title="star: kept through CLEAR">${b.star ? '★' : '☆'}</button><button class="chip" data-ando="compare">COMPARE</button><button class="chip" data-ando="tx" ${a.runs.length ? '' : 'disabled'}>SEND TO TX</button>${this.txOpen ? '<button class="chip" data-ando="back">BACK</button>' : ''}<button class="chip" data-ando="close" title="close (Esc)">✕</button></div>`
      + `<div class="ctlrow">${seg('view', ['amp', 'freq', 'iq', 'spec'], this.view, v => ({ amp: 'AMPLITUDE', freq: 'FREQUENCY', iq: 'I/Q', spec: 'SPECTROGRAM' }[v]!))}</div>`
      + `<div class="an-wave"><canvas id="an-canvas"></canvas></div>`
      + `<div class="an-zoom"><button class="chip" data-ando="zoom" ${this.pick ? '' : 'disabled'}>ZOOM</button><button class="chip" data-ando="full">FULL</button><span id="an-selinfo">${selTxt}</span><span class="an-grow"></span>${seg('fmt', ['bits', 'hex', 'ascii'], this.fmt, v => v.toUpperCase())}</div>`
      + `<div class="an-out" id="an-out">${this.outHtml(a)}</div>`
      + `<div class="an-scroll">`
      + `<div class="an-ctl"><span class="rl">MOD</span>${seg('mod', ['AUTO', ...MODS], o.mod ?? 'AUTO')}<span class="rl">CODING</span>${seg('coding', ['AUTO', ...CODINGS], o.coding ?? 'AUTO', v => (v === 'AUTO' ? v : CODING_LABEL[v as Coding]))}</div>`
      + `<div class="an-ctl"><span class="rl">SYMBOL</span><div class="stepper an-step"><button data-ando="sym-">−</button><b>${a.symUs.toFixed(1)} µs</b><button data-ando="sym+">+</button></div><button class="tog ${o.symUs ? '' : 'on'}" data-ando="symauto">AUTO</button>`
      + `<span class="rl">CUT</span><input id="an-thr" type="range" min="2" max="98" value="${Math.round(a.thr * 100)}"><b class="an-pct">${Math.round(a.thr * 100)}%</b><button class="tog ${o.thr !== undefined ? '' : 'on'}" data-ando="thrauto">AUTO</button>`
      + `<button class="tog ${o.invert ? 'on' : ''}" data-ando="invert">INVERT</button><button class="tog ${this.selOnly ? 'on' : ''}" data-ando="selonly">SELECTION ONLY</button></div>`
      + `<div class="an-why">${why}</div>`
      + `<div class="an-sub">PULSE LENGTHS <i class="mk">marks</i> <i class="sp">gaps</i></div><canvas id="an-hist" class="an-hist"></canvas>`
      + fieldsHtml
      + `<div class="an-why">${b.matches.length ? `DEVICES DECODERS: ${b.matches.map(esc).join(' · ')}` : 'no Devices decoder claimed it'}</div>`
      + `<div class="an-ctl"><span class="rl">NAME</span><input id="an-nm" class="txin an-grow" maxlength="60" value="${esc(b.name)}" placeholder="what it is (gate, left key, lock…)"></div>`
      + `<div class="an-ctl"><span class="rl">NOTE</span><textarea id="an-nt" class="txin an-grow" rows="2" maxlength="500" placeholder="anything worth remembering about it">${esc(b.note)}</textarea></div>`
      + `<div class="an-ctl"><span class="rl">EXPORT</span><button class="chip" data-ando="cu8">.CU8</button><button class="chip" data-ando="cs8">.CS8</button><button class="chip" data-ando="sub" ${a.runs.length ? '' : 'disabled'}>.SUB</button><span class="an-dim">${(b.rate / 1e3).toFixed(0)} kHz I/Q, ${b.n} samples</span></div>`
      + `</div>`;
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

  private wireDetail(det: HTMLElement, b: AnBurst): void {
    det.querySelectorAll<HTMLButtonElement>('[data-anview]').forEach(x => x.onclick = () => { this.view = x.dataset.anview as View; this.draw(); });
    det.querySelectorAll<HTMLButtonElement>('[data-anfmt]').forEach(x => x.onclick = () => { this.fmt = x.dataset.anfmt as Fmt; this.draw(); });
    det.querySelectorAll<HTMLButtonElement>('[data-anmod]').forEach(x => x.onclick = () => this.setOver(b, o => { o.mod = x.dataset.anmod === 'AUTO' ? undefined : x.dataset.anmod as Mod; o.thr = undefined; }));
    det.querySelectorAll<HTMLButtonElement>('[data-ancoding]').forEach(x => x.onclick = () => this.setOver(b, o => { o.coding = x.dataset.ancoding === 'AUTO' ? undefined : x.dataset.ancoding as Coding; }));
    const thr = det.querySelector<HTMLInputElement>('#an-thr');
    if (thr) { thr.oninput = () => { const pct = det.querySelector('.an-pct'); if (pct) pct.textContent = `${thr.value}%`; }; thr.onchange = () => this.setOver(b, o => { o.thr = +thr.value / 100; }); }
    const nm = det.querySelector<HTMLInputElement>('#an-nm'), nt = det.querySelector<HTMLTextAreaElement>('#an-nt');
    if (nm) nm.onchange = () => { b.name = nm.value.trim(); this.save(b); this.draw(false); };
    if (nt) nt.onchange = () => { b.note = nt.value.trim(); this.save(b); this.draw(false); };
    det.querySelectorAll<HTMLButtonElement>('[data-ando]').forEach(x => x.onclick = () => {
      const a = this.reading(b);
      switch (x.dataset.ando) {
        case 'close': this.close(); break;
        case 'star': b.star = !b.star; this.save(b); this.draw(); break;
        case 'back': this.back(); break;
        case 'compare': this.cmpTx = 0; this.comparing = true; this.fields = []; this.check = null; this.colPick = null; this.draw(); break;
        case 'zoom': if (this.pick) { this.zoom = this.pick; this.pick = null; this.draw(); } break;
        case 'full': this.zoom = [0, b.n]; this.pick = null; this.draw(); break;
        case 'sym-': this.setOver(b, o => { o.symUs = a.symUs / 1.05; }); break;
        case 'sym+': this.setOver(b, o => { o.symUs = a.symUs * 1.05; }); break;
        case 'symauto': this.setOver(b, o => { o.symUs = undefined; }); break;
        case 'thrauto': this.setOver(b, o => { o.thr = undefined; }); break;
        case 'invert': this.setOver(b, o => { o.invert = o.invert ? undefined : true; }); break;
        case 'selonly': this.selOnly = !this.selOnly; this.draw(); break;
        case 'cu8': save(exportName(b.center + b.hz, b.rate, b.id, 'cu8'), toCu8(b.iq)); break;
        case 'cs8': save(exportName(b.center + b.hz, b.rate, b.id, 'cs8'), toCs8(b.iq)); break;
        case 'sub': save(exportName(b.center + b.hz, b.rate, b.id, 'sub'), new TextEncoder().encode(this.subOf(b, a))); break;
        case 'tx': this.opened = false; this.host.sendToTx(this.subOf(b, a), b.center ? b.center + b.hz : this.host.center() + b.hz, a.mod === 'FSK'); break;
      }
    });
    const cv = det.querySelector<HTMLCanvasElement>('#an-canvas');
    if (cv) { this.paint(cv, b); this.wireTrace(cv, b); }
    const hc = det.querySelector<HTMLCanvasElement>('#an-hist');
    if (hc) paintHistogram(hc, this.reading(b), b.rate);
    const out = det.querySelector<HTMLElement>('#an-out');
    if (out && cv) this.wireOut(out, cv, b);
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

  /** Drag across the trace to select a stretch of it; hover to find a bit in the text. */
  private wireTrace(cv: HTMLCanvasElement, b: AnBurst): void {
    const at = (e: PointerEvent) => { const r = cv.getBoundingClientRect(), [a0, a1] = this.shown(b); return Math.round(a0 + Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * (a1 - a0)); };
    let from = -1;
    cv.onpointerdown = (e) => { from = at(e); cv.setPointerCapture(e.pointerId); };
    cv.onpointermove = (e) => {
      const i = at(e);
      if (from < 0) {
        const hit = this.bitAt(this.reading(b), i);
        const next = hit ? { f: hit.f, b0: hit.b, b1: hit.b + 1 } : null;
        if (JSON.stringify(next) !== JSON.stringify(this.hl)) { this.hl = next; this.paint(cv, b); this.markOut(); }
        return;
      }
      this.pick = i === from ? null : [Math.min(from, i), Math.max(from, i)];
      this.paint(cv, b);
      const info = this.root?.querySelector('#an-selinfo');
      if (info && this.pick) info.textContent = `${((this.pick[1] - this.pick[0]) / b.rate * 1000).toFixed(3)} ms · ${((this.pick[1] - this.pick[0]) / b.rate * 1e6 / Math.max(1, this.reading(b).symUs)).toFixed(1)} symbols`;
    };
    cv.onpointerup = (e) => {
      if (from < 0) return;
      const tap = Math.abs(at(e) - from) < 4;
      from = -1;
      if (tap) {
        // a tap on touch lights the bit under the finger, as hovering does with a mouse
        this.pick = null;
        const hit = this.bitAt(this.reading(b), at(e));
        this.hl = hit ? { f: hit.f, b0: hit.b, b1: hit.b + 1 } : null;
        this.paint(cv, b); this.markOut();
        return;
      }
      this.draw();
    };
    cv.onpointerleave = () => { if (from < 0 && this.hl) { this.hl = null; this.paint(cv, b); this.markOut(); } };
    cv.ondblclick = () => { this.zoom = [0, b.n]; this.pick = null; this.draw(); };
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

  private paint(cv: HTMLCanvasElement, b: AnBurst): void {
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(200, Math.round(cv.clientWidth * dpr)), H = Math.round((cv.clientHeight || 260) * dpr);
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    const g = cv.getContext('2d')!;
    const css = getComputedStyle(cv);
    const ink = css.getPropertyValue('--ink').trim() || '#e8ecf4', accent = css.getPropertyValue('--accent').trim() || '#4c8dff';
    const accent2 = css.getPropertyValue('--accent2').trim() || '#ffaf00', muted = css.getPropertyValue('--muted').trim() || '#8d97ab';
    const paper = css.getPropertyValue('--paper').trim() || '#0a0d13';
    g.fillStyle = paper; g.fillRect(0, 0, W, H);
    const [a0, a1] = this.shown(b);
    const len = Math.max(1, a1 - a0);
    const xOf = (i: number) => (i - a0) / len * W;
    const a = this.reading(b);
    const axisH = 14 * dpr, bitH = 18 * dpr, digH = 16 * dpr, top = 4 * dpr;
    const plotH = H - axisH - bitH - digH - top - 4 * dpr;

    // frames, shaded behind everything
    g.fillStyle = color(accent, 0.08);
    for (const f of a.frames) g.fillRect(xOf(f.start), 0, Math.max(1, xOf(f.end) - xOf(f.start)), top + plotH + digH);

    if (this.view === 'spec') this.paintSpec(g, b, a, a0, a1, W, top, plotH, paper, accent, accent2);
    else if (this.view === 'iq') {
      let m = 1;
      for (let i = a0; i < a1; i++) m = Math.max(m, Math.abs(b.iq[2 * i]), Math.abs(b.iq[2 * i + 1]));
      const yOf = (v: number) => top + plotH / 2 - v / m * plotH / 2;
      g.strokeStyle = color(muted, 0.4); g.lineWidth = 1; g.beginPath(); g.moveTo(0, yOf(0)); g.lineTo(W, yOf(0)); g.stroke();
      for (const [k, col] of [[0, accent], [1, accent2]] as [number, string][]) {
        g.strokeStyle = col; g.lineWidth = Math.max(1, dpr); g.globalAlpha = 0.85; g.beginPath();
        for (let x = 0; x < W; x++) {
          const i0 = a0 + Math.floor(x * len / W), i1 = Math.max(i0 + 1, a0 + Math.floor((x + 1) * len / W));
          let mn = 127, mx = -128;
          for (let i = i0; i < i1 && i < b.n; i++) { const v = b.iq[2 * i + k]; if (v < mn) mn = v; if (v > mx) mx = v; }
          if (len < W) { if (x === 0) g.moveTo(x, yOf(b.iq[2 * i0 + k])); else g.lineTo(x, yOf(b.iq[2 * i0 + k])); } else { g.moveTo(x + 0.5, yOf(mx)); g.lineTo(x + 0.5, yOf(mn) + 0.5); }
        }
        g.stroke(); g.globalAlpha = 1;
      }
      g.font = `${10 * dpr}px ui-monospace, monospace`;
      g.fillStyle = accent; g.fillText('I', 4 * dpr, top + 10 * dpr); g.fillStyle = accent2; g.fillText('Q', 14 * dpr, top + 10 * dpr);
    } else {
      const sig = this.view === 'amp' ? b.env : b.fm;
      // the discriminator is only worth drawing where there is a carrier: elsewhere it is noise from rail to rail
      const on = this.view === 'freq' ? carrierOf(b.env, b.n, noiseOf(b.env, b.n, b.rate)) : null;
      let lo = Infinity, hi = -Infinity;
      for (let i = a0; i < a1; i++) { if (on && !on[i]) continue; const v = sig[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
      if (lo === Infinity) { lo = -1; hi = 1; }
      if (this.view === 'freq') { const m = Math.max(Math.abs(lo), Math.abs(hi), 1); lo = -m; hi = m; } else lo = 0;
      if (hi <= lo) hi = lo + 1;
      const yOf = (v: number) => top + plotH - (v - lo) / (hi - lo) * plotH;
      if (this.view === 'freq') { g.strokeStyle = color(muted, 0.4); g.lineWidth = 1; g.beginPath(); g.moveTo(0, yOf(0)); g.lineTo(W, yOf(0)); g.stroke(); }
      g.strokeStyle = accent; g.lineWidth = Math.max(1, dpr);
      g.beginPath();
      if (len < W) {
        // zoomed in past a sample a pixel: join the samples up, or the trace falls apart into dots
        let pen = false;
        for (let i = a0; i <= a1 && i < b.n; i++) {
          if (on && !on[i]) { pen = false; continue; }
          const x = xOf(i + 0.5), y = yOf(sig[i]);
          if (pen) g.lineTo(x, y); else g.moveTo(x, y);
          pen = true;
        }
      } else for (let x = 0; x < W; x++) {
        const i0 = a0 + Math.floor(x * len / W), i1 = Math.max(i0 + 1, a0 + Math.floor((x + 1) * len / W));
        let mn = Infinity, mx = -Infinity;
        for (let i = i0; i < i1 && i < b.n; i++) { if (on && !on[i]) continue; const v = sig[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
        if (mn === Infinity) continue;
        g.moveTo(x + 0.5, yOf(mx)); g.lineTo(x + 0.5, yOf(mn) + 0.5);
      }
      g.stroke();
      const sliced = (this.view === 'freq') === (a.mod === 'FSK');
      if (sliced && a.runs.length) { g.strokeStyle = accent2; g.setLineDash([6 * dpr, 4 * dpr]); g.beginPath(); g.moveTo(0, yOf(a.cut)); g.lineTo(W, yOf(a.cut)); g.stroke(); g.setLineDash([]); }
      g.fillStyle = muted; g.font = `${10 * dpr}px ui-monospace, monospace`;
      const toKhz = (v: number) => v / FM_SCALE * b.rate / (2 * Math.PI) / 1e3;
      g.fillText(this.view === 'freq' ? `±${toKhz(hi).toFixed(0)} kHz` : `${(20 * Math.log10(Math.max(1, hi) / 16384)).toFixed(0)} dBFS peak`, 4 * dpr, top + 10 * dpr);
    }

    // the sliced line, under the trace
    const y0 = top + plotH + digH - 3 * dpr, y1 = top + plotH + 4 * dpr;
    g.strokeStyle = ink; g.lineWidth = Math.max(1, dpr);
    g.beginPath();
    let pos = a.from, lvl = false;
    g.moveTo(0, y0);
    for (const r of a.runs) {
      const x0 = xOf(pos), x1 = xOf(pos + r.n);
      if (x1 >= 0 && x0 <= W) { const y = r.hi ? y1 : y0; if (r.hi !== lvl) g.lineTo(Math.max(0, x0), y); g.lineTo(Math.min(W, x1), y); }
      lvl = r.hi; pos += r.n;
    }
    g.stroke();

    // the bits: each bit's span as a cell, its value written in when there is room, the highlighted ones lit
    const by = top + plotH + digH + 2 * dpr;
    g.font = `${11 * dpr}px ui-monospace, monospace`; g.textAlign = 'center'; g.textBaseline = 'middle';
    for (let fi = 0; fi < a.frames.length; fi++) {
      const f = a.frames[fi], s = f.spans;
      if (!s.length || xOf(s[s.length - 1]) < 0 || xOf(s[0]) > W) continue;
      const per = (xOf(s[s.length - 1]) - xOf(s[0])) / Math.max(1, f.bits.length);
      for (let k = 0; k < f.bits.length; k++) {
        const x0 = xOf(s[2 * k]), x1 = xOf(s[2 * k + 1]);
        if (x1 < 0 || x0 > W) continue;
        const lit = this.hl && this.hl.f === fi && k >= this.hl.b0 && k < this.hl.b1;
        if (lit) { g.fillStyle = color(accent2, 0.85); g.fillRect(x0, by, Math.max(1, x1 - x0), bitH); g.fillStyle = color(accent2, 0.16); g.fillRect(x0, 0, Math.max(1, x1 - x0), by); }
        else if (k % 2) { g.fillStyle = color(muted, 0.12); g.fillRect(x0, by, Math.max(1, x1 - x0), bitH); }
        if (per >= 3) { g.fillStyle = color(muted, 0.5); g.fillRect(x0, by, 1, bitH); }
        if (per >= 7 * dpr) { g.fillStyle = lit ? paper : f.bits[k] === '1' ? ink : muted; g.fillText(f.bits[k], (x0 + x1) / 2, by + bitH / 2); }
      }
    }
    g.textAlign = 'left'; g.textBaseline = 'alphabetic';

    if (this.pick) {
      g.fillStyle = color(accent2, 0.18); g.strokeStyle = accent2;
      const x0 = xOf(this.pick[0]), x1 = xOf(this.pick[1]);
      g.fillRect(x0, 0, x1 - x0, H - axisH); g.strokeRect(x0 + 0.5, 0.5, x1 - x0 - 1, H - axisH - 1);
    }
    g.fillStyle = muted; g.font = `${10 * dpr}px ui-monospace, monospace`;
    const ms = (i: number) => `${(i / b.rate * 1000).toFixed(len / b.rate < 0.01 ? 3 : 1)} ms`;
    g.fillText(ms(a0), 2 * dpr, H - 3 * dpr);
    const t = ms(a1); g.fillText(t, W - g.measureText(t).width - 2 * dpr, H - 3 * dpr);
  }

  /** The burst as a spectrogram: 64-point transforms spread across the width, frequency up, the FSK tones ticked. */
  private paintSpec(g: CanvasRenderingContext2D, b: AnBurst, a: Analysis, a0: number, a1: number, W: number, top: number, h: number, paper: string, accent: string, accent2: string): void {
    const N = 64, win = hann(N), re = new Float32Array(N), im = new Float32Array(N);
    const cols = Math.min(W, Math.max(1, Math.floor((a1 - a0) / 2)));
    const img = g.createImageData(cols, N);
    const mags: Float32Array[] = [];
    let peak = 1e-9;
    for (let c = 0; c < cols; c++) {
      const mid = a0 + Math.round((c + 0.5) * (a1 - a0) / cols);
      for (let k = 0; k < N; k++) { const i = Math.max(0, Math.min(b.n - 1, mid - N / 2 + k)); re[k] = b.iq[2 * i] * win[k]; im[k] = b.iq[2 * i + 1] * win[k]; }
      fft(re, im);
      const m = new Float32Array(N);
      for (let k = 0; k < N; k++) { const v = re[k] * re[k] + im[k] * im[k]; m[k] = v; if (v > peak) peak = v; }
      mags.push(m);
    }
    const lo = rgb(paper), mid = rgb(accent), hi = rgb(accent2);
    for (let c = 0; c < cols; c++) for (let k = 0; k < N; k++) {
      const bin = (k + N / 2) % N;
      const db = 10 * Math.log10(mags[c][bin] / peak + 1e-12);
      const t = Math.pow(Math.max(0, Math.min(1, (db + 45) / 45)), 1.6);
      const [r, gg, bb] = t < 0.6 ? mix(lo, mid, t / 0.6) : mix(mid, hi, (t - 0.6) / 0.4);
      const p = ((N - 1 - k) * cols + c) * 4;
      img.data[p] = r; img.data[p + 1] = gg; img.data[p + 2] = bb; img.data[p + 3] = 255;
    }
    const tmp = document.createElement('canvas'); tmp.width = cols; tmp.height = N;
    tmp.getContext('2d')!.putImageData(img, 0, 0);
    g.imageSmoothingEnabled = false;
    g.drawImage(tmp, 0, top, W, h);
    const dpr = window.devicePixelRatio || 1;
    g.fillStyle = 'rgba(255,255,255,0.75)'; g.font = `${10 * dpr}px ui-monospace, monospace`;
    g.fillText(`+${(b.rate / 2e3).toFixed(0)} kHz`, 4 * dpr, top + 12 * dpr); g.fillText(`−${(b.rate / 2e3).toFixed(0)} kHz`, 4 * dpr, top + h - 4 * dpr);
    if (a.mod === 'FSK') {
      const toHz = (v: number) => v / FM_SCALE * b.rate / (2 * Math.PI);
      for (const v of [a.lo, a.hi]) { const y = top + h / 2 - toHz(v) / b.rate * h; g.fillStyle = accent2; g.fillRect(W - 10 * dpr, y - dpr, 10 * dpr, 2 * dpr); g.fillText(`${(toHz(v) / 1e3).toFixed(1)} kHz`, W - 70 * dpr, y - 3 * dpr); }
    }
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

/** URH's pulse-length histogram: marks above the line, gaps below it, the symbol multiples as faint guides. */
function paintHistogram(cv: HTMLCanvasElement, a: Analysis, rate: number): void {
  const dpr = window.devicePixelRatio || 1;
  const W = Math.max(200, Math.round(cv.clientWidth * dpr)), H = Math.round((cv.clientHeight || 90) * dpr);
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  const g = cv.getContext('2d')!, css = getComputedStyle(cv);
  const paper = css.getPropertyValue('--paper').trim() || '#0a0d13', muted = css.getPropertyValue('--muted').trim() || '#8d97ab';
  const markC = '#3fd07a', gapC = css.getPropertyValue('--accent2').trim() || '#ffaf00';
  g.fillStyle = paper; g.fillRect(0, 0, W, H);
  if (!a.runs.length) return;
  const h = histogram(a, rate);
  const n = h.marks.length, bw = W / n, mid = (H - 12 * dpr) / 2, max = Math.max(1, ...h.marks, ...h.spaces);
  g.strokeStyle = color(muted, 0.35); g.lineWidth = 1;
  for (let k = 1; k * a.symUs < h.binUs * n; k++) { const x = k * a.symUs / h.binUs * bw; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H - 12 * dpr); g.stroke(); }
  for (let i = 0; i < n; i++) {
    const hm = h.marks[i] / max * (mid - 2), hs = h.spaces[i] / max * (mid - 2);
    g.fillStyle = markC; g.fillRect(i * bw + 1, mid - hm, Math.max(1, bw - 2), hm);
    g.fillStyle = gapC; g.fillRect(i * bw + 1, mid, Math.max(1, bw - 2), hs);
  }
  g.fillStyle = muted; g.font = `${10 * dpr}px ui-monospace, monospace`;
  for (let k = 1; k * a.symUs < h.binUs * n && k <= 8; k++) g.fillText(`${(k * a.symUs).toFixed(0)}`, k * a.symUs / h.binUs * bw + 2 * dpr, H - 2 * dpr);
  g.fillText('µs', W - 16 * dpr, H - 2 * dpr);
}

/** The card glyph: a pulse train. */
const WAVE_GLYPH = '<svg viewBox="0 0 24 24"><path d="M2 17h3V7h3.5v10H11V7h1.8v10h3V7H20v10h2"/></svg>';

function save(name: string, bytes: Uint8Array): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

function rgb(c: string): [number, number, number] {
  const m = /^#([0-9a-f]{6})$/i.exec(c.trim());
  if (m) { const v = parseInt(m[1], 16); return [v >> 16, (v >> 8) & 255, v & 255]; }
  const r = /rgba?\((\d+)[, ]+(\d+)[, ]+(\d+)/.exec(c);
  return r ? [+r[1], +r[2], +r[3]] : [0, 0, 0];
}
const mix = (a: [number, number, number], b: [number, number, number], t: number): [number, number, number] => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
function color(c: string, alpha: number): string { const [r, g, b] = rgb(c); return `rgba(${r},${g},${b},${alpha})`; }
