/**
 * The Analyzer screen: the list of captured signals, the selected one's waveform in three views, its demodulation
 * (worked out, or set by hand), its frames as bits, hex and text, and its repeats lined up bit by bit.
 *
 * The capture runs in the worker (`dsp/analyzer/capture.ts`); everything here reads what it sends. Kept out of
 * main.ts so the screen can be read on its own; main.ts supplies the shell around it through `Host`.
 * Twin of the Android ui/AnalyzerScreen.kt and the iPad/Mac App/ui/AnalyzerScreen.swift.
 */

import { fft, hann } from './fft.js';
import { analyze, carrierOf, noiseOf, bitsToAscii, bitsToHex, pulsesUs, CODINGS, FM_SCALE, MODS, type Analysis, type Coding, type Mod, type Overrides } from './dsp/analyzer/demod.js';
import { align, similar, type Alignment } from './dsp/analyzer/align.js';
import { exportName, freqFromName, toCs8, toCu8, toSub } from './dsp/analyzer/files.js';
import type { Burst } from './dsp/analyzer/capture.js';

/** What the screen needs from the app around it. */
export interface Host {
  /** The radio's center now, Hz. */
  center(): number;
  /** Send to the DSP worker. */
  post(msg: Record<string, unknown>, transfer?: Transferable[]): void;
  /** Whether the Analyzer is the app on screen. */
  showing(): boolean;
  log(line: string): void;
}

/** A captured burst as the screen keeps it: the capture's arrays, where it was, and how it read with nothing set. */
export interface AnBurst extends Burst {
  /** The radio's center when it was heard (or the file's), Hz; 0 when a file did not say. */
  center: number;
  auto: Analysis;
  /** The longest frame's bits, for the card and for comparing. */
  best: string;
}

type View = 'amp' | 'freq' | 'iq';
type Fmt = 'bits' | 'hex' | 'ascii';

/** Bursts kept: the oldest go first. */
const MAX_KEPT = 200;

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const two = (n: number) => String(n).padStart(2, '0');
const clock = (t: number) => { const d = new Date(t); return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`; };
const mhz = (hz: number) => `${(hz / 1e6).toFixed(3)} MHz`;
const CODING_LABEL: Record<Coding, string> = { NRZ: 'NRZ', Manchester: 'MANCH', PWM: 'PWM', PPM: 'PPM' };
const rateLabel = (bps: number) => (bps >= 1000 ? `${(bps / 1000).toFixed(2)} kbit/s` : `${bps.toFixed(0)} bit/s`);
const group8 = (bits: string) => bits.replace(/(.{8})/g, '$1 ').trim();

export class AnalyzerUi {
  readonly bursts: AnBurst[] = [];
  private sel = 0;
  private view: View = 'amp';
  private fmt: Fmt = 'hex';
  /** Hand settings for each burst, by id. */
  private readonly over = new Map<number, Overrides>();
  /** The part of the burst shown, in samples, and the part selected by dragging. */
  private zoom: [number, number] | null = null;
  private pick: [number, number] | null = null;
  private selOnly = false;
  private comparing = false;
  /** Bursts left out of the comparison. */
  private readonly left = new Set<number>();
  capturing = true;
  private stats: { channels: number; followed: number; captured: number; span: number } | null = null;
  private pending = 0;
  private root: HTMLElement | null = null;

  constructor(private readonly host: Host) {}

  // ---- what the worker sends ----------------------------------------------------------------------------------

  onBurst(b: Burst, fromFile: boolean): void {
    const center = fromFile ? (freqFromName(b.src ?? '') ?? 0) : this.host.center();
    const auto = analyze(b.env, b.fm, b.n, b.rate);
    const best = auto.frames.reduce((a, f) => (f.bits.length > a.length ? f.bits : a), '');
    this.bursts.push({ ...b, center, auto, best });
    if (this.bursts.length > MAX_KEPT) { const gone = this.bursts.shift()!; this.over.delete(gone.id); this.left.delete(gone.id); }
    if (!this.sel || fromFile && !this.bursts.some(x => x.id === this.sel)) this.sel = b.id;
    this.refresh();
  }
  onStats(m: { channels: number; followed: number; captured: number; span: number }): void { this.stats = m; this.refresh(); }
  onImport(m: { name: string; count: number; note: string }): void { this.host.log(`Analyzer: ${m.count} burst${m.count === 1 ? '' : 's'} in ${m.name}${m.note ? ` (${m.note})` : ''}`); this.flash(`${m.count} BURST${m.count === 1 ? '' : 'S'} IN ${m.name}`); }
  clear(): void { this.bursts.length = 0; this.over.clear(); this.left.clear(); this.sel = 0; this.zoom = this.pick = null; this.comparing = false; this.draw(); }

  // ---- the screen -------------------------------------------------------------------------------------------

  /** The Analyzer's own part of the screen, under the waterfall and the band presets main.ts draws. */
  html(): string {
    return `
      <div class="ctlrow"><button id="an-cap" class="tog">CAPTURE</button><button id="an-imp" class="tog">IMPORT</button><input id="an-file" type="file" accept=".cu8,.cs8,.u8,.iq,.raw,.sub" hidden><span class="row an-grow"></span><button class="ib" id="an-clear" title="clear" aria-label="clear">✕</button></div>
      <div id="an-stats" class="mt-sum"><div>listening&hellip;</div></div>
      <div class="an-stage"><div id="an-list" class="mt-cards an-cards"></div><div id="an-detail" class="an-detail"></div></div>
      <div class="note">Every burst in the span is tuned to on its own and kept whole, from 12 ms before it began: its loudness, its frequency and its raw samples. Pick one to see it, read it to bits (the modulation, symbol length, threshold and line coding are worked out, and each can be set by hand), and COMPARE to line its repeats up bit by bit: what stays fixed is preamble, sync and ID, what changes is the rolling code, counter or checksum. A burst one of the Devices decoders knows says so. Export one as raw I/Q or a Flipper .sub, or import either.</div>`;
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
      this.host.post({ type: 'analyzer', cmd: 'import', name: f.name, bytes }, [bytes]);
    };
    $('an-clear').onclick = () => this.clear();
    $('an-list').onclick = (e) => {
      const c = (e.target as HTMLElement).closest<HTMLElement>('[data-an]');
      if (!c) return;
      const id = +c.dataset.an!;
      if (this.comparing && (e.target as HTMLElement).closest('[data-antog]')) { if (!this.left.delete(id)) this.left.add(id); this.draw(); return; }
      if (id !== this.sel) { this.sel = id; this.zoom = this.pick = null; }
      this.draw();
    };
    this.host.post({ type: 'analyzer', cmd: 'pause', on: !this.capturing });
    this.draw();
  }

  private flash(s: string): void { const st = this.root?.querySelector('#an-stats'); if (st) st.innerHTML = `<div>${esc(s)}</div>`; }

  /** Coalesced: bursts can arrive several at once, and redrawing the list under a finger is unpleasant. */
  refresh(): void {
    if (this.pending || !this.host.showing()) return;
    this.pending = window.setTimeout(() => { this.pending = 0; this.draw(); }, 200);
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
    const o = { ...(this.over.get(b.id) ?? {}) };
    if (this.selOnly && (this.pick || this.zoom)) { const r = this.pick ?? this.zoom!; o.from = r[0]; o.to = r[1]; }
    return Object.keys(o).length ? analyze(b.env, b.fm, b.n, b.rate, o) : b.auto;
  }

  draw(): void {
    const root = this.root;
    if (!root || !root.isConnected) return;
    const st = root.querySelector('#an-stats');
    if (st) {
      const s = this.stats, c = this.host.center();
      const matched = this.bursts.filter(b => b.matches.length).length;
      st.innerHTML = (s ? `<div>WATCHING ${((c - s.span / 2) / 1e6).toFixed(2)}–${((c + s.span / 2) / 1e6).toFixed(2)} MHz${s.channels ? ` · TUNED TO ${s.channels} BURST${s.channels === 1 ? '' : 'S'} NOW` : ''}${this.capturing ? '' : ' · CAPTURE OFF'}</div>` : `<div>${this.capturing ? 'listening…' : 'CAPTURE OFF'}</div>`)
        + `<div class="muted">${this.bursts.length} captured · ${matched} matched a Devices decoder${s ? ` · ${s.followed} bursts followed` : ''}</div>`;
    }
    const list = root.querySelector<HTMLElement>('#an-list');
    if (list) {
      const top = list.scrollTop;
      const cmp = this.comparing ? new Set(this.group().map(b => b.id)) : null;
      list.innerHTML = this.bursts.length
        ? [...this.bursts].reverse().map(b => this.card(b, cmp)).join('')
        : '<div class="mt-wait dv-empty">nothing yet. Press a key fob or a remote near the antenna, or IMPORT a recording (.cu8 .cs8 .sub)</div>';
      list.scrollTop = top;
    }
    const det = root.querySelector<HTMLElement>('#an-detail');
    if (det) {
      const b = this.selected();
      det.hidden = !b;
      if (b) { det.innerHTML = this.comparing ? this.compareHtml(b) : this.detailHtml(b); this.wireDetail(det, b); }
    }
  }

  private card(b: AnBurst, cmp: Set<number> | null): string {
    const a = b.auto;
    const hz = b.center ? mhz(b.center + b.hz) : `${b.hz >= 0 ? '+' : ''}${(b.hz / 1e3).toFixed(0)} kHz`;
    const when = b.src ? `+${b.t.toFixed(3)} s` : clock(b.wall);
    const big = a.frames.length ? `${a.mod} · ${a.coding.toUpperCase()}` : a.mod === 'OOK' && a.why.startsWith('a plain') ? 'CARRIER' : a.mod;
    const sub = a.frames.length ? `${rateLabel(a.baud)} · ${b.best.length} bits${a.frames.length > 1 ? ` · ${a.frames.length} frames` : ''}` : a.why;
    const inCmp = cmp?.has(b.id);
    const tog = cmp && inCmp ? `<button class="chip an-tog ${this.left.has(b.id) ? '' : 'on'}" data-antog title="include in the comparison">${this.left.has(b.id) ? 'OUT' : 'IN'}</button>` : '';
    return `<div class="mt-card dv-card an-card k-${a.mod.toLowerCase()} ${this.sel === b.id ? 'sel' : ''} ${cmp && !inCmp ? 'dim' : ''}" data-an="${b.id}">`
      + `<div class="mt-h"><span class="dv-glyph">${WAVE_GLYPH}</span><span class="mt-k"><b>${esc(hz)}</b><small>${b.src ? esc(b.src) : `burst ${b.id}`}</small></span><span class="mt-live">${esc(when)}</span>${tog}</div>`
      + `<div class="mt-clk"><b>${esc(big)}</b><small>${esc(sub)}</small></div>`
      + (b.best ? `<div class="mt-hex">${esc(bitsToHex(b.best))}</div>` : '')
      + (b.matches.length ? `<div class="an-match">${b.matches.map(m => `<span>${esc(m)}</span>`).join('')}</div>` : '')
      + `<div class="dv-foot"><span>${b.ms.toFixed(1)} ms</span><span>${b.dbfs.toFixed(0)} dBFS · ${b.snr.toFixed(0)} dB SNR</span></div></div>`;
  }

  private detailHtml(b: AnBurst): string {
    const a = this.reading(b), o = this.over.get(b.id) ?? {};
    const hz = b.center ? mhz(b.center + b.hz) : `${(b.hz / 1e3).toFixed(1)} kHz off center`;
    const seg = (name: string, vals: string[], cur: string, label = (v: string) => v) => `<div class="seg an-seg">${vals.map(v => `<button data-an${name}="${v}" class="${cur === v ? 'on' : ''}">${label(v)}</button>`).join('')}</div>`;
    const r = this.pick ?? this.zoom;
    const selTxt = r ? `${((r[1] - r[0]) / b.rate * 1000).toFixed(3)} ms · ${((r[1] - r[0]) / b.rate * 1e6 / Math.max(1, a.symUs)).toFixed(1)} symbols` : 'drag across the trace to select';
    const frames = a.frames.map((f, i) => {
      const body = this.fmt === 'bits' ? group8(f.bits) : this.fmt === 'hex' ? bitsToHex(f.bits) : bitsToAscii(f.bits);
      return `<div class="an-frame"><b>${i + 1}</b><i>${f.bits.length}</i><span>${esc(body)}</span></div>`;
    }).join('');
    const why = `${a.mod} (${esc(a.why)}) · ${a.coding} · symbol ${a.symUs.toFixed(1)} µs · ${rateLabel(a.baud)}${a.mod === 'FSK' ? ` · shift ${(a.shiftHz / 1e3).toFixed(1)} kHz` : ''}`;
    return `<div class="mt-dh"><b>${esc(hz)}</b><span>${b.src ? esc(b.src) + ' · +' + b.t.toFixed(3) + ' s' : clock(b.wall)} · ${b.ms.toFixed(1)} ms · ${b.snr.toFixed(0)} dB SNR</span><button class="chip" data-ando="compare">COMPARE</button><button class="chip" data-ando="close">✕</button></div>`
      + `<div class="ctlrow">${seg('view', ['amp', 'freq', 'iq'], this.view, v => ({ amp: 'AMPLITUDE', freq: 'FREQUENCY', iq: 'I/Q' }[v]!))}</div>`
      + `<div class="an-wave"><canvas id="an-canvas"></canvas><div class="an-zoom"><button class="chip" data-ando="zoom" ${this.pick ? '' : 'disabled'}>ZOOM</button><button class="chip" data-ando="full">FULL</button><span id="an-selinfo">${selTxt}</span></div></div>`
      + `<div class="an-ctl"><span class="rl">MOD</span>${seg('mod', ['AUTO', ...MODS], o.mod ?? 'AUTO')}</div>`
      + `<div class="an-ctl"><span class="rl">CODING</span>${seg('coding', ['AUTO', ...CODINGS], o.coding ?? 'AUTO', v => (v === 'AUTO' ? v : CODING_LABEL[v as Coding]))}</div>`
      + `<div class="an-ctl"><span class="rl">SYMBOL</span><div class="stepper an-step"><button data-ando="sym-">−</button><b>${a.symUs.toFixed(1)} µs</b><button data-ando="sym+">+</button></div><button class="tog ${o.symUs ? '' : 'on'}" data-ando="symauto">AUTO</button>`
      + `<span class="rl">CUT</span><input id="an-thr" type="range" min="2" max="98" value="${Math.round(a.thr * 100)}"><b class="an-pct">${Math.round(a.thr * 100)}%</b><button class="tog ${o.thr !== undefined ? '' : 'on'}" data-ando="thrauto">AUTO</button></div>`
      + `<div class="an-ctl"><button class="tog ${o.invert ? 'on' : ''}" data-ando="invert">INVERT</button><button class="tog ${this.selOnly ? 'on' : ''}" data-ando="selonly">SELECTION ONLY</button><span class="an-grow"></span>${seg('fmt', ['bits', 'hex', 'ascii'], this.fmt, v => v.toUpperCase())}</div>`
      + `<div class="an-why">${why}</div>`
      + `<div class="an-frames">${frames || '<div class="mt-wait">no frames: set the modulation, symbol or cut by hand, or select the part that carries data</div>'}</div>`
      + `<div class="an-why">${b.matches.length ? `DEVICES DECODERS: ${b.matches.map(esc).join(' · ')}` : 'no Devices decoder claimed it'}</div>`
      + `<div class="an-ctl"><span class="rl">EXPORT</span><button class="chip" data-ando="cu8">.CU8</button><button class="chip" data-ando="cs8">.CS8</button><button class="chip" data-ando="sub" ${a.runs.length ? '' : 'disabled'}>.SUB</button><span class="an-dim">${(b.rate / 1e3).toFixed(0)} kHz I/Q, ${b.n} samples</span></div>`;
  }

  // ---- compare ------------------------------------------------------------------------------------------------

  /** The bursts that read like the selected one: the comparison's candidates. */
  private group(): AnBurst[] {
    const b = this.selected();
    if (!b || !b.best) return [];
    const sum = this.bursts.filter(x => x.best).map(x => ({ x, mod: x.auto.mod, coding: x.auto.coding, symUs: x.auto.symUs, bits: x.best.length }));
    const me = sum.find(s => s.x.id === b.id)!;
    return similar(sum, me).map(s => s.x);
  }

  private compareHtml(b: AnBurst): string {
    const rows = this.group().filter(x => !this.left.has(x.id) || x.id === b.id);
    const al = align(rows.map(x => x.best));
    const head = `<div class="mt-dh"><b>COMPARE</b><span>${rows.length} frame${rows.length === 1 ? '' : 's'} like burst ${b.id} · ${b.auto.mod} · ${b.auto.coding} · ${b.auto.symUs.toFixed(0)} µs</span><button class="chip" data-ando="back">BACK</button><button class="chip" data-ando="close">✕</button></div>`;
    if (rows.length < 2) return head + '<div class="mt-wait">capture the same button a few more times: frames that read alike are lined up here</div>';
    return head + this.alignedHtml(al, rows, b.id);
  }

  private alignedHtml(al: Alignment, rows: AnBurst[], selId: number): string {
    const pre = al.preamble, sync = al.sync;
    const sum = `${rows.length} frames · ${pre ? `preamble ${pre[1] - pre[0]} bits · ` : ''}${sync ? `sync ${sync.hex} · ` : ''}${al.fixedBits} fixed · ${al.changingBits} changing`;
    const total = Math.max(1, al.segments.reduce((n, s) => n + s.to - s.from, 0));
    const bar = al.segments.map(s => `<i class="${s.fixed ? 'f' : 'c'}" style="flex:${s.to - s.from}" title="${s.fixed ? 'fixed' : 'changing'} ${s.to - s.from} bits"><b>${s.to - s.from > total / 40 ? s.to - s.from : ''}</b></i>`).join('');
    // the column ruler: P over the preamble, S over the sync word, a tick every 8 bits from where the data starts
    const start = pre ? pre[1] : sync ? sync.from : 0;
    let ruler = '';
    for (let c = 0; c < al.width; c++) ruler += pre && c >= pre[0] && c < pre[1] ? 'P' : sync && c >= sync.from && c < sync.to ? 'S' : c >= start && (c - start) % 8 === 0 ? '|' : ' ';
    const cls = (c: number) => (al.state[c] === 1 ? 'f' : al.state[c] === 0 ? 'c' : 'u');
    const line = (bits: string, shift: number) => {
      let out = ' '.repeat(shift).replace(/ /g, '<u> </u>');
      let run = '', k = '';
      for (let j = 0; j < bits.length; j++) {
        const c = cls(shift + j);
        if (c !== k && run) { out += `<${k === 'f' ? 'em' : k === 'c' ? 'strong' : 'u'}>${run}</${k === 'f' ? 'em' : k === 'c' ? 'strong' : 'u'}>`; run = ''; }
        k = c; run += bits[j];
      }
      if (run) out += `<${k === 'f' ? 'em' : k === 'c' ? 'strong' : 'u'}>${run}</${k === 'f' ? 'em' : k === 'c' ? 'strong' : 'u'}>`;
      return out;
    };
    const body = al.rows.map(r => { const x = rows[r.index]; return `<div class="${x.id === selId ? 'me' : ''}"><b>${x.id}</b><code>${line(r.bits, r.shift)}</code></div>`; }).join('');
    // the consensus a byte at a time from the sync word: hex where all eight bits are fixed, dots where any change
    let bytes = '';
    for (let c = start; c + 8 <= al.width; c += 8) {
      let fixed = true; for (let k = 0; k < 8; k++) if (al.state[c + k] !== 1) fixed = false;
      bytes += `<span class="${fixed ? 'f' : 'c'}">${fixed ? parseInt(al.consensus.slice(c, c + 8), 2).toString(16).toUpperCase().padStart(2, '0') : '··'}</span>`;
    }
    return `<div class="an-why">${esc(sum)}</div><div class="an-segbar">${bar}</div>`
      + `<div class="an-bytes"><b>BYTES FROM THE ${pre ? 'END OF THE PREAMBLE' : 'SYNC WORD'}</b>${bytes}</div>`
      + `<div class="an-align"><div class="ruler"><b></b><code>${ruler.replace(/ /g, '&nbsp;')}</code></div>${body}</div>`
      + `<div class="an-legend"><em>fixed</em> <strong>changing</strong> <u>one frame only</u> · tap IN / OUT on a card to leave a frame out</div>`;
  }

  // ---- the detail's controls ----------------------------------------------------------------------------------

  private setOver(b: AnBurst, f: (o: Overrides) => void): void {
    const o = { ...(this.over.get(b.id) ?? {}) }; f(o);
    for (const k of Object.keys(o) as (keyof Overrides)[]) if (o[k] === undefined) delete o[k];
    if (Object.keys(o).length) this.over.set(b.id, o); else this.over.delete(b.id);
    this.draw();
  }

  private wireDetail(det: HTMLElement, b: AnBurst): void {
    det.querySelectorAll<HTMLButtonElement>('[data-anview]').forEach(x => x.onclick = () => { this.view = x.dataset.anview as View; this.draw(); });
    det.querySelectorAll<HTMLButtonElement>('[data-anfmt]').forEach(x => x.onclick = () => { this.fmt = x.dataset.anfmt as Fmt; this.draw(); });
    det.querySelectorAll<HTMLButtonElement>('[data-anmod]').forEach(x => x.onclick = () => this.setOver(b, o => { o.mod = x.dataset.anmod === 'AUTO' ? undefined : x.dataset.anmod as Mod; o.thr = undefined; }));
    det.querySelectorAll<HTMLButtonElement>('[data-ancoding]').forEach(x => x.onclick = () => this.setOver(b, o => { o.coding = x.dataset.ancoding === 'AUTO' ? undefined : x.dataset.ancoding as Coding; }));
    const thr = det.querySelector<HTMLInputElement>('#an-thr');
    if (thr) thr.oninput = () => { const pct = det.querySelector('.an-pct'); if (pct) pct.textContent = `${thr.value}%`; };
    if (thr) thr.onchange = () => this.setOver(b, o => { o.thr = +thr.value / 100; });
    det.querySelectorAll<HTMLButtonElement>('[data-ando]').forEach(x => x.onclick = () => {
      const a = this.reading(b);
      switch (x.dataset.ando) {
        case 'close': this.sel = 0; this.comparing = false; this.draw(); break;
        case 'compare': this.comparing = true; this.draw(); break;
        case 'back': this.comparing = false; this.draw(); break;
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
        case 'sub': save(exportName(b.center + b.hz, b.rate, b.id, 'sub'), new TextEncoder().encode(toSub(pulsesUs(a, b.rate), b.center ? b.center + b.hz : 433_920_000, a.mod === 'FSK', a.shiftHz))); break;
      }
    });
    const cv = det.querySelector<HTMLCanvasElement>('#an-canvas');
    if (cv) { this.paint(cv, b); this.wireDrag(cv, b); }
  }

  /** Drag across the trace to select a stretch of it. */
  private wireDrag(cv: HTMLCanvasElement, b: AnBurst): void {
    const span = () => this.shown(b);
    const at = (e: PointerEvent) => { const r = cv.getBoundingClientRect(), [a0, a1] = span(); return Math.round(a0 + Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * (a1 - a0)); };
    let from = -1;
    cv.onpointerdown = (e) => { from = at(e); cv.setPointerCapture(e.pointerId); };
    cv.onpointermove = (e) => {
      if (from < 0) return;
      const to = at(e);
      this.pick = to === from ? null : [Math.min(from, to), Math.max(from, to)];
      this.paint(cv, b);
      const info = this.root?.querySelector('#an-selinfo');
      if (info && this.pick) info.textContent = `${((this.pick[1] - this.pick[0]) / b.rate * 1000).toFixed(3)} ms · ${((this.pick[1] - this.pick[0]) / b.rate * 1e6 / Math.max(1, this.reading(b).symUs)).toFixed(1)} symbols`;
    };
    cv.onpointerup = () => { if (from < 0) return; from = -1; if (this.pick && this.pick[1] - this.pick[0] < 4) this.pick = null; this.draw(); };
    cv.ondblclick = () => { this.zoom = [0, b.n]; this.pick = null; this.draw(); };
  }

  // ---- the waveform -------------------------------------------------------------------------------------------

  private paint(cv: HTMLCanvasElement, b: AnBurst): void {
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(200, Math.round(cv.clientWidth * dpr)), H = Math.round((cv.clientHeight || 200) * dpr);
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
    const digH = Math.round(18 * dpr), top = 4 * dpr, plotH = H - digH - 14 * dpr - top;

    // frames, shaded behind everything
    g.fillStyle = color(accent, 0.1);
    for (const f of a.frames) g.fillRect(xOf(f.start), 0, Math.max(1, xOf(f.end) - xOf(f.start)), H - 14 * dpr);

    if (this.view === 'iq') this.paintIq(g, b, a0, a1, W, top, plotH, paper, accent, accent2);
    else {
      const sig = this.view === 'amp' ? b.env : b.fm;
      // the discriminator is only worth drawing where there is a carrier: elsewhere it is noise from rail to rail
      const on = this.view === 'freq' ? carrierOf(b.env, b.n, noiseOf(b.env, b.n, b.rate)) : null;
      let lo = Infinity, hi = -Infinity;
      for (let i = a0; i < a1; i++) { if (on && !on[i]) continue; const v = sig[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
      if (lo === Infinity) { lo = -1; hi = 1; }
      if (this.view === 'freq') { const m = Math.max(Math.abs(lo), Math.abs(hi), 1); lo = -m; hi = m; } else lo = 0;
      if (hi <= lo) hi = lo + 1;
      const yOf = (v: number) => top + plotH - (v - lo) / (hi - lo) * plotH;
      // zero line for the discriminator
      if (this.view === 'freq') { g.strokeStyle = color(muted, 0.4); g.lineWidth = 1; g.beginPath(); g.moveTo(0, yOf(0)); g.lineTo(W, yOf(0)); g.stroke(); }
      g.strokeStyle = accent; g.lineWidth = Math.max(1, dpr);
      g.beginPath();
      for (let x = 0; x < W; x++) {
        const i0 = a0 + Math.floor(x * len / W), i1 = Math.max(i0 + 1, a0 + Math.floor((x + 1) * len / W));
        let mn = Infinity, mx = -Infinity;
        for (let i = i0; i < i1 && i < b.n; i++) { if (on && !on[i]) continue; const v = sig[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
        if (mn === Infinity) continue;
        g.moveTo(x + 0.5, yOf(mx)); g.lineTo(x + 0.5, yOf(mn) + 0.5);
      }
      g.stroke();
      // the cut line, when this view is the one sliced
      const sliced = (this.view === 'freq') === (a.mod === 'FSK');
      if (sliced && a.runs.length) {
        g.strokeStyle = accent2; g.setLineDash([6 * dpr, 4 * dpr]); g.beginPath(); g.moveTo(0, yOf(a.cut)); g.lineTo(W, yOf(a.cut)); g.stroke(); g.setLineDash([]);
      }
      // axis note
      g.fillStyle = muted; g.font = `${10 * dpr}px ui-monospace, monospace`;
      const toKhz = (v: number) => v / FM_SCALE * b.rate / (2 * Math.PI) / 1e3;
      g.fillText(this.view === 'freq' ? `±${toKhz(hi).toFixed(0)} kHz` : `${(20 * Math.log10(Math.max(1, hi) / 16384)).toFixed(0)} dBFS peak`, 4 * dpr, top + 10 * dpr);
    }

    // the sliced line, under the trace
    const y0 = H - 14 * dpr - 3 * dpr, y1 = y0 - digH + 6 * dpr;
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

    // the selection
    if (this.pick) {
      g.fillStyle = color(accent2, 0.18); g.strokeStyle = accent2;
      const x0 = xOf(this.pick[0]), x1 = xOf(this.pick[1]);
      g.fillRect(x0, 0, x1 - x0, H - 14 * dpr); g.strokeRect(x0 + 0.5, 0.5, x1 - x0 - 1, H - 14 * dpr - 1);
    }
    // time axis
    g.fillStyle = muted; g.font = `${10 * dpr}px ui-monospace, monospace`;
    const ms = (i: number) => `${(i / b.rate * 1000).toFixed(len / b.rate < 0.01 ? 3 : 1)} ms`;
    g.fillText(ms(a0), 2 * dpr, H - 3 * dpr);
    const t = ms(a1); g.fillText(t, W - g.measureText(t).width - 2 * dpr, H - 3 * dpr);
  }

  /** The raw I/Q as a spectrogram: 64-point transforms every 16 samples (or spread to the width), frequency up. */
  private paintIq(g: CanvasRenderingContext2D, b: AnBurst, a0: number, a1: number, W: number, top: number, h: number, paper: string, accent: string, accent2: string): void {
    const N = 64, win = hann(N), re = new Float32Array(N), im = new Float32Array(N);
    const cols = Math.min(W, Math.max(1, Math.floor((a1 - a0) / 4)));
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
      const bin = (k + N / 2) % N;                        // negative frequencies at the bottom
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
    g.fillStyle = 'rgba(255,255,255,0.7)'; g.font = `${10 * (window.devicePixelRatio || 1)}px ui-monospace, monospace`;
    g.fillText(`+${(b.rate / 2e3).toFixed(0)} kHz`, 4, top + 12); g.fillText(`−${(b.rate / 2e3).toFixed(0)} kHz`, 4, top + h - 4);
  }
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
