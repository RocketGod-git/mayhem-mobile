/**
 * Waterfall + spectrum + axis widget (the twin of ui/Waterfall.kt), rendered at device resolution.
 *
 * - One waterfall column per device pixel (up to 4096), one row per spectrum frame, kept in an offscreen ring
 *   canvas so a new row costs one putImageData and two drawImage blits — no per-frame copy of the whole history.
 * - Spectra arrive as 0..1 values (the worker normalizes against a median floor); they are resampled to the
 *   column count with max-pooling so narrow carriers never fall between pixels.
 * - Inferno-style 256-entry color map, dB grid on the spectrum with the floor / range the worker reports.
 */

export type AxisLabel = [number, string];

function css(name: string): string { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

/** Inferno-like color LUT: black → violet → magenta → orange → yellow → near-white. */
const LUT = (() => {
  const stops: [number, number, number, number][] = [
    [0.00, 0, 0, 4], [0.13, 31, 12, 72], [0.25, 85, 15, 109], [0.38, 136, 34, 106], [0.50, 186, 54, 85],
    [0.63, 227, 89, 51], [0.75, 249, 140, 10], [0.88, 249, 201, 50], [1.00, 252, 255, 164],
  ];
  const lut = new Uint8ClampedArray(256 * 4);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let k = 0; while (k < stops.length - 2 && t > stops[k + 1][0]) k++;
    const [t0, r0, g0, b0] = stops[k], [t1, r1, g1, b1] = stops[k + 1];
    const f = Math.min(1, Math.max(0, (t - t0) / (t1 - t0)));
    lut[i * 4] = r0 + (r1 - r0) * f; lut[i * 4 + 1] = g0 + (g1 - g0) * f; lut[i * 4 + 2] = b0 + (b1 - b0) * f; lut[i * 4 + 3] = 255;
  }
  return lut;
})();

export interface ScopeOpts {
  /** CSS-pixel row count when the host has no layout height yet. */
  rows?: number;
  center?: boolean;
  spectrumHeight?: number;
  onTap?: (frac: number) => void;
  onPreview?: (frac: number | null) => void;
  /** The channel's shaded edges can be dragged: called with the new low / high edges as full-span fractions. */
  onChannel?: (loFrac: number, hiFrac: number, which: 'lo' | 'hi') => void;
  /** Span bar under the axis: the user dragged it so the span's center should sit at `frac` (0..1 of the bar); `done` on release. */
  onSlide?: (frac: number, done: boolean) => void;
  /** Zooming past 1×: −1 = the app should widen the span (raise the sample rate), +1 = narrow it. Returns true when it did. */
  onSpanStep?: (dir: -1 | 1) => boolean;
  /**
   * A two-finger drag when the view is already showing the whole span, as a fraction of the width moved since
   * the gesture began. There is nothing to pan to inside the view, so the host slides the span instead.
   */
  onDragSpan?: (deltaFrac: number, done: boolean) => void;
  /** The ⌖ button: bring the view back to the tuned channel. */
  onCenter?: () => void;
  /** Frequency label for a 0..1 position across the full span (used for the carrier annotations and, when zoomed, the axis); `zoom` says how magnified the view is. */
  labelAt?: (frac: number, zoom?: number) => string;
  /** Device pixels of waterfall height per pushed row (CSS px, scaled by dpr). Sweeps push one row per sweep, so they use ~3. */
  rowPx?: number;
}

export class Scope {
  cols: number;
  /** Called after the scope re-sizes itself to a new column count (the app forwards it to the worker). */
  onResize?: (cols: number) => void;
  private readonly wf: HTMLCanvasElement;
  private readonly sp: HTMLCanvasElement;
  private readonly axis: HTMLElement;
  private readonly wfCtx: CanvasRenderingContext2D;
  private ring: HTMLCanvasElement;
  private ringCtx: CanvasRenderingContext2D;
  private rowImg: ImageData;
  /**
   * Waterfall memory beyond the view: a canvas several spans wide, anchored to absolute frequency, holding every
   * row at 1× resolution. The ring (`ring`) is only ever one span wide, so panning and then panning back used to
   * find black where history had been pushed off its edge. The memory repaints exactly those places — the sliver
   * a pan exposes, a tune jump, the wings when zooming out — and nothing else, so the ring's own higher-resolution
   * rows always win where they exist. Null when the pixel budget says no (tiny screens are the ring alone).
   */
  private mem: HTMLCanvasElement | null = null;
  private memCtx: CanvasRenderingContext2D | null = null;
  private memW = 0;
  /** Memory column where the current span's left edge (full-span fraction 0) sits. Moves as the span slides. */
  private memOrigin = 0;
  private memRow = new Float32Array(0);
  private memImg: ImageData | null = null;
  private peak: Float32Array;
  private last = new Float32Array(0);
  private rows: number;
  private head = 0;
  private filled = 0;
  private center: boolean;
  private floorDb = NaN; private rangeDb = 40;
  private channel: number | null = null;
  private channelAt = 0.5;
  private readonly host: HTMLElement;
  private pushes = 0;
  private signals: { frac: number; val: number; text: string }[] | null = null;
  private prefix = new Float64Array(0);
  private smooth = new Float32Array(0);
  private stamps: Float64Array;
  private readonly labelAt?: (frac: number, zoom?: number) => string;
  /** View window: the span fraction at the left edge and the magnification (window width = 1 / zoom). */
  zoom = 1; private start = 0;
  private fullLabels: AxisLabel[] = [];
  private readonly adjustable: boolean;
  private zoomText: HTMLElement | null = null;
  private lastGesture = 0;                    // when the user last worked the waterfall; the view holds still after
  private thumb: HTMLElement | null = null;
  private barLabels: HTMLElement[] = [];
  private barLo = 0; private barHi = 1; private spanText = '1×';
  private readonly rowPx: number;
  private readonly fixedCols: boolean;
  private readonly dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));

  /** Device pixels across the host, honoring any CSS zoom on the page. */
  private static measure(el: HTMLElement, fallback: number): number {
    const r = el.getBoundingClientRect();
    return r.width > 0 ? r.width : fallback;
  }
  /** Device pixels per CSS pixel *as laid out*, i.e. devicePixelRatio × any CSS zoom on the page — the unit for
   *  canvas text and line widths so they match the surrounding UI on zoomed ultra-wide layouts. */
  private ui(): number {
    const cw = this.wf.clientWidth; if (!cw) return this.dpr;
    const r = this.wf.getBoundingClientRect();
    return r.width > 0 ? this.dpr * (r.width / cw) : this.dpr;
  }
  private fitCols(host: HTMLElement): number { return Math.max(256, Math.min(8192, Math.round(Scope.measure(host, 512) * this.dpr))); }
  private fitRows(fallback: number): number { const r = this.wf.getBoundingClientRect(); return Math.max(64, Math.min(4096, Math.round((r.height > 0 ? r.height : fallback) * this.dpr))); }

  /** cols = 0 picks one column per device pixel of the host (256..8192) and follows the host when it resizes. */
  constructor(host: HTMLElement, cols: number, opts: ScopeOpts = {}) {
    this.host = host;
    host.classList.add('scope');
    host.innerHTML = `<canvas class="wf"></canvas><canvas class="sp" style="height:${opts.spectrumHeight ?? 90}px"></canvas><div class="axis"></div>`;
    this.wf = host.querySelector('.wf') as HTMLCanvasElement;
    this.sp = host.querySelector('.sp') as HTMLCanvasElement;
    this.axis = host.querySelector('.axis') as HTMLElement;
    this.fixedCols = cols > 0;
    this.cols = cols || this.fitCols(host);
    this.rows = this.fitRows(opts.rows ?? 160);
    this.wf.width = this.cols; this.wf.height = this.rows;
    this.wfCtx = this.wf.getContext('2d', { alpha: false })!;
    this.ring = document.createElement('canvas'); this.ring.width = this.cols; this.ring.height = this.rows;
    this.ringCtx = this.ring.getContext('2d', { alpha: false })!;
    this.ringCtx.fillStyle = '#000004'; this.ringCtx.fillRect(0, 0, this.cols, this.rows);
    this.wfCtx.fillStyle = '#000004'; this.wfCtx.fillRect(0, 0, this.cols, this.rows);
    this.rowImg = this.ringCtx.createImageData(this.cols, 1);
    this.allocMem(this.cols, this.rows);
    this.peak = new Float32Array(this.cols);
    this.stamps = new Float64Array(this.rows);
    this.labelAt = opts.labelAt;
    this.adjustable = !!opts.onChannel;
    // Floor, not round: at a fractional device ratio (1.5 on a 150% display or browser zoom) rounding 1×1.5 up
    // to 2 device pixels per row halved the waterfall's history and drew it chunky. Flooring keeps one device
    // pixel per row there — twice the seconds on screen and finer detail — and is unchanged at integer ratios and
    // for the sweep (which asks for 2).
    this.rowPx = Math.max(1, Math.floor((opts.rowPx ?? 1) * this.dpr));
    this.center = opts.center ?? true;
    // Re-fit the canvas resolution to the element on any size change. A throttle, not a debounce: the canvas has
    // to keep pace *during* a window drag, or it sits CSS-stretched (blocky) until the drag stops. A trailing call
    // lands the final exact size. The window 'resize' event is a belt-and-braces for anywhere the element-level
    // ResizeObserver does not fire.
    let lastFit = 0, trailing = 0;
    const fitNow = () => { lastFit = performance.now(); if (trailing) { clearTimeout(trailing); trailing = 0; } this.refit(host); };
    const onSize = () => { const dt = performance.now() - lastFit; if (dt >= 70) fitNow(); else if (!trailing) trailing = window.setTimeout(fitNow, 70 - dt); };
    if (typeof ResizeObserver !== 'undefined') { const ro = new ResizeObserver(onSize); ro.observe(host); }
    window.addEventListener('resize', onSize);
    // zoom control in the corner; ctrl+wheel (or a pinch) zooms about the pointer, shift-drag / two-finger drag pans, the span bar slides the span
    const zc = document.createElement('div'); zc.className = 'zoomctl'; zc.innerHTML = '<button data-c title="back to the tuned channel">⌖</button><button data-z="-" title="zoom out">−</button><span>1×</span><button data-z="+" title="zoom in">+</button>'; host.appendChild(zc);
    this.zoomText = zc.querySelector('span');
    zc.querySelector('[data-c]')!.addEventListener('click', (e) => { e.stopPropagation(); opts.onCenter?.(); });
    zc.querySelector('[data-z="-"]')!.addEventListener('click', (e) => { e.stopPropagation(); if (this.zoom <= 1) { opts.onSpanStep?.(-1); return; } this.setView(this.zoom / 2); });
    zc.querySelector('[data-z="+"]')!.addEventListener('click', (e) => { e.stopPropagation(); if (this.zoom <= 1 && opts.onSpanStep?.(1)) return; this.setView(this.zoom * 2); });
    zc.addEventListener('pointerdown', e => e.stopPropagation());
    // span bar: a scrollbar for the spectrum — the thumb is the span (with the zoomed window inside it), drag it to slide the receiver
    if (opts.onSlide) {
      const bar = document.createElement('div'); bar.className = 'spanbar'; bar.innerHTML = '<span class="l"></span><span class="r"></span><div class="thumb"><i></i></div>';
      host.appendChild(bar); host.classList.add('hasbar');
      this.thumb = bar.querySelector('.thumb'); this.barLabels = [...bar.querySelectorAll<HTMLElement>('span')];
      const barFrac = (x: number) => { const r = bar.getBoundingClientRect(); return r.width > 0 ? Math.min(1, Math.max(0, (x - r.left) / r.width)) : 0.5; };
      let grab = 0, dragging = false, lastF = 0.5;
      bar.addEventListener('pointerdown', (ev) => {
        if (ev.pointerType === 'mouse' && ev.button !== 0) return;
        ev.preventDefault(); ev.stopPropagation(); try { bar.setPointerCapture(ev.pointerId); } catch { /* synthetic pointer */ }
        const f = barFrac(ev.clientX), c = (this.barLo + this.barHi) / 2;
        grab = f >= this.barLo - 0.01 && f <= this.barHi + 0.01 ? f - c : 0;   // grabbed the thumb: keep the offset; elsewhere: jump there
        dragging = true; lastF = f - grab; bar.classList.add('drag');
        if (grab === 0) opts.onSlide!(lastF, false);
      });
      bar.addEventListener('pointermove', (ev) => { if (!dragging) return; lastF = barFrac(ev.clientX) - grab; opts.onSlide!(lastF, false); });
      const end = () => { if (!dragging) return; dragging = false; bar.classList.remove('drag'); opts.onSlide!(lastF, true); };
      bar.addEventListener('pointerup', end); bar.addEventListener('pointercancel', end);
      this.drawBar();
    }
    // Measured against the waterfall itself, not its container: the canvas is inset by the panel's border, so
    // using the container puts every tap a fraction of a pixel out, which is a real frequency error once the
    // span is wide.
    const dispFrac = (clientX: number) => { const r = this.wf.getBoundingClientRect(); return Math.min(1, Math.max(0, (clientX - r.left) / r.width)); };
    host.addEventListener('wheel', (ev) => {
      if (!ev.ctrlKey && !ev.metaKey) return;
      ev.preventDefault();
      if (this.zoom <= 1 && ev.deltaY > 0) { opts.onSpanStep?.(-1); return; }          // past 1×: widen the span itself
      if (this.zoom <= 1 && ev.deltaY < 0 && opts.onSpanStep?.(1)) return;
      const f = this.start + dispFrac(ev.clientX) / this.zoom;        // keep the frequency under the pointer still
      const z = ev.deltaY < 0 ? this.zoom * 2 : this.zoom / 2;
      this.setView(z, f, dispFrac(ev.clientX));
    }, { passive: false });
    // Press anywhere, slide left/right to pick a frequency (a guide line + preview readout follow the finger),
    // and the radio retunes only when the finger or button is lifted. Vertical swipes still scroll the page.
    // A second finger (or shift with the mouse) pans and pinches the view instead of tuning.
    const guide = document.createElement('div'); guide.className = 'guide'; guide.hidden = true; host.appendChild(guide);
    const pointers = new Map<number, number>();                      // pointerId → clientX
    let active = false, panning = false, panStart = 0, panFrom = 0, pinchDist = 0, pinchZoom = 1, pinchMid = 0, pinchStart = 0;
    // A two-finger drag on a view that is already showing everything: the host slides the span instead.
    let spanDrag = false, spanDelta = 0;
    let edge: 'lo' | 'hi' | null = null;
    // which channel edge (if any) is under the pointer: within 8 css px of the shaded band's side
    const edgeHit = (clientX: number): 'lo' | 'hi' | null => {
      if (this.channel === null || !opts.onChannel) return null;
      const r = host.getBoundingClientRect(), x = dispFrac(clientX), tol = 8 / Math.max(1, r.width);
      const ca = (this.channelAt - this.start) * this.zoom, cw = this.channel * this.zoom;
      if (Math.abs(x - (ca + cw / 2)) < tol) return 'hi';
      if (Math.abs(x - (ca - cw / 2)) < tol) return 'lo';
      return null;
    };
    const show = (f: number) => { guide.hidden = false; guide.style.left = `${(f * 100).toFixed(2)}%`; opts.onPreview?.(this.start + f / this.zoom); };
    const cancel = () => { active = false; guide.hidden = true; opts.onPreview?.(null); };
    const down = (ev: PointerEvent) => {
      if (ev.pointerType === 'mouse' && ev.button !== 0) return;
      this.lastGesture = performance.now();
      try { (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId); } catch { /* synthetic pointer */ }
      pointers.set(ev.pointerId, ev.clientX);
      if (pointers.size === 2) {                                       // pinch / two-finger pan
        cancel(); active = false; panning = false;
        const [a, b] = [...pointers.values()]; pinchDist = Math.max(8, Math.abs(a - b)); pinchZoom = this.zoom; pinchMid = dispFrac((a + b) / 2); pinchStart = this.start;
        // At 1x the whole span is on screen, so panning within the view is a no-op; the host slides the span.
        spanDrag = this.zoom <= 1.001 && !!opts.onDragSpan; spanDelta = 0;
        return;
      }
      if (ev.shiftKey && this.zoom > 1) { panning = true; panStart = dispFrac(ev.clientX); panFrom = this.start; return; }
      edge = edgeHit(ev.clientX);
      if (edge) return;                                                // dragging a filter edge, not tuning
      if (!opts.onTap) return;
      active = true; show(dispFrac(ev.clientX));
    };
    const move = (ev: PointerEvent) => {
      if (pointers.has(ev.pointerId)) pointers.set(ev.pointerId, ev.clientX);
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const z = Math.min(32, Math.max(1, pinchZoom * Math.abs(a - b) / pinchDist));
        const mid = dispFrac((a + b) / 2);
        if (spanDrag) {
          // Spreading the fingers is a pinch, not a pan: hand the gesture over once the view has zoomed in.
          if (z > 1.05) { spanDrag = false; }
          else { spanDelta = mid - pinchMid; opts.onDragSpan!(spanDelta, false); return; }
        }
        // the frequency that was under the pinch center stays under it while the fingers move
        const under = pinchStart + pinchMid / pinchZoom;
        this.setView(z, under, mid);
        return;
      }
      if (panning) { this.setView(this.zoom, undefined, undefined, panFrom - (dispFrac(ev.clientX) - panStart) / this.zoom); return; }
      if (edge && this.channel !== null) {
        const f = this.start + dispFrac(ev.clientX) / this.zoom;
        let lo = this.channelAt - this.channel / 2, hi = this.channelAt + this.channel / 2;
        if (edge === 'lo') lo = Math.min(f, hi - 0.0005); else hi = Math.max(f, lo + 0.0005);
        opts.onChannel!(lo, hi, edge);
        return;
      }
      if (pointers.size === 0) { const h = edgeHit(ev.clientX); (ev.currentTarget as HTMLElement).style.cursor = h ? 'ew-resize' : opts.onTap ? 'crosshair' : 'default'; }
      if (active) show(dispFrac(ev.clientX));
    };
    const up = (ev: PointerEvent) => {
      pointers.delete(ev.pointerId); this.lastGesture = performance.now();
      if (spanDrag && pointers.size < 2) { opts.onDragSpan?.(spanDelta, true); spanDrag = false; spanDelta = 0; return; }
      if (edge) { edge = null; return; }
      if (panning) { if (pointers.size === 0) panning = false; return; }
      if (!active) return;
      const f = dispFrac(ev.clientX); cancel();
      if (pointers.size === 0) opts.onTap?.(this.start + f / this.zoom);
    };
    const lost = (ev: PointerEvent) => {
      pointers.delete(ev.pointerId);
      if (spanDrag && pointers.size < 2) { opts.onDragSpan?.(spanDelta, true); spanDrag = false; spanDelta = 0; }
      panning = false; edge = null; cancel();
    };
    for (const el of [this.wf, this.sp]) {
      el.addEventListener('pointerdown', down); el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up); el.addEventListener('pointercancel', lost);
      el.style.touchAction = opts.onTap ? 'pan-y' : 'pan-y'; el.style.cursor = opts.onTap ? 'crosshair' : 'default';
    }
    this.draw();
  }

  /** Re-size the canvases to the host (window resized, pane resized); the history is rescaled into the new ring. */
  private refit(host: HTMLElement): void {
    if (!host.isConnected) return;
    const cols = this.fixedCols ? this.cols : this.fitCols(host);
    const rows = this.fitRows(this.rows / this.dpr);
    if (cols === this.cols && rows === this.rows) { this.draw(); return; }
    // unroll the old ring into time order (newest first), scale it into a new ring of the new size
    const ordered = document.createElement('canvas'); ordered.width = this.cols; ordered.height = this.rows;
    const og = ordered.getContext('2d')!;
    const below = this.rows - this.head;
    og.drawImage(this.ring, 0, this.head, this.cols, below, 0, 0, this.cols, below);
    if (this.head > 0) og.drawImage(this.ring, 0, 0, this.cols, this.head, 0, below, this.cols, this.head);
    const ring = document.createElement('canvas'); ring.width = cols; ring.height = rows;
    const rg = ring.getContext('2d', { alpha: false })!;
    rg.fillStyle = '#000004'; rg.fillRect(0, 0, cols, rows);
    rg.imageSmoothingEnabled = true; rg.drawImage(ordered, 0, 0, this.cols, this.rows, 0, 0, cols, rows);
    const stamps = new Float64Array(rows);
    for (let y = 0; y < rows; y++) stamps[y] = this.stamps[(this.head + Math.min(this.rows - 1, Math.floor(y * this.rows / rows))) % this.rows];
    const peak = new Float32Array(cols);
    for (let x = 0; x < cols; x++) peak[x] = this.peak[Math.min(this.cols - 1, Math.floor(x * this.cols / cols))];
    // Re-fit the memory too (reads the old geometry, so before it changes) — but never let a failure here stop
    // the canvas itself from resizing, or a resize would leave the waterfall stretched. On error, drop the memory
    // and carry on; it rebuilds from the next rows.
    try { this.refitMem(cols, rows); } catch { this.allocMem(cols, rows); }
    this.filled = Math.min(rows, Math.round(this.filled * rows / this.rows));
    this.cols = cols; this.rows = rows; this.head = 0;
    this.ring = ring; this.ringCtx = rg; this.stamps = stamps; this.peak = peak;
    this.wf.width = cols; this.wf.height = rows;
    this.rowImg = this.ringCtx.createImageData(cols, 1);
    this.last = new Float32Array(0);
    this.wfCtx.drawImage(this.ring, 0, 0);
    this.overlay(); this.draw();
    this.onResize?.(this.bins);
  }

  /** CSS-pixel width of the waterfall (for turning a finger's width into Hz). */
  get cssWidth(): number { return this.wf.clientWidth || 1; }
  /** Spectrum bins the producer should send: one per column of the full span, times the magnification (worker caps at 8192). */
  get bins(): number { return Math.min(8192, this.cols * this.zoom); }

  /**
   * Magnify the view: `zoom` (1 = the whole span), keeping the full-span fraction `keep` under display position
   * `at` (defaults: the window center), or set the window's left edge `startFrac` directly. The waterfall history
   * is re-projected so what was already painted lines up with what comes next.
   */
  setView(zoom: number, keep?: number, at?: number, startFrac?: number): void {
    const oldStart = this.start, oldZoom = this.zoom;
    zoom = Math.min(32, Math.max(1, zoom));
    let start = startFrac ?? (keep !== undefined ? keep - (at ?? 0.5) / zoom : oldStart + 0.5 / oldZoom - 0.5 / zoom);
    start = Math.min(1 - 1 / zoom, Math.max(0, start));
    if (zoom === oldZoom && Math.abs(start - oldStart) < 1e-6) return;
    this.zoom = zoom; this.start = start;
    // re-project the ring: the new window's slice of the old window, stretched to the full width
    const cols = this.cols, rows = this.rows;
    const sx = (start - oldStart) * oldZoom * cols, sw = cols * oldZoom / zoom;
    const ring = document.createElement('canvas'); ring.width = cols; ring.height = rows;
    const rg = ring.getContext('2d', { alpha: false })!;
    rg.fillStyle = '#000004'; rg.fillRect(0, 0, cols, rows);
    rg.imageSmoothingEnabled = zoom < oldZoom;
    // Paint the whole new window from the memory first (zooming out otherwise leaves black wings either side of
    // the old window), then lay the old ring's higher-resolution rows over it where they exist.
    this.backfill(rg, 0, cols);
    // clip the source to the ring (drawImage with a source outside the canvas is not portable)
    const x0 = Math.max(0, sx), x1 = Math.min(cols, sx + sw);
    if (x1 > x0) rg.drawImage(this.ring, x0, 0, x1 - x0, rows, (x0 - sx) * cols / sw, 0, (x1 - x0) * cols / sw, rows);
    this.ring = ring; this.ringCtx = rg; this.rowImg = rg.createImageData(cols, 1);
    const peak = new Float32Array(cols);
    for (let x = 0; x < cols; x++) { const src = Math.floor(sx + (x + 0.5) * sw / cols); peak[x] = src >= 0 && src < cols ? this.peak[src] : 0; }
    this.peak = peak; this.last = new Float32Array(0);
    this.host.classList.toggle('zoomed', zoom > 1);
    this.drawBar();
    this.applyLabels();
    this.onResize?.(this.bins);
    const below = rows - this.head;
    this.wfCtx.drawImage(this.ring, 0, this.head, cols, below, 0, 0, cols, below);
    if (this.head > 0) this.wfCtx.drawImage(this.ring, 0, 0, cols, this.head, 0, below, cols, this.head);
    this.overlay(); this.draw();
  }
  /** Where the span sits on the span bar (fractions of the bar), the bar's end labels, and what to call the span at 1×. */
  setSpanBar(lo: number, hi: number, left: string, right: string, spanText: string): void {
    this.barLo = lo; this.barHi = hi; this.spanText = spanText;
    if (this.barLabels.length === 2) { this.barLabels[0].textContent = left; this.barLabels[1].textContent = right; }
    this.drawBar();
  }
  private drawBar(): void {
    if (this.zoomText) this.zoomText.textContent = this.zoom > 1 ? `${this.zoom}×` : this.spanText;
    const t = this.thumb; if (!t) return;
    // Keep the thumb on screen and grabbable however small or off-edge the view is against the bar. On the
    // launcher the bar is the whole 1 MHz–6 GHz range, so a 20 MHz view is a hair — without a floor and an
    // in-range clamp it vanishes at the ends and you cannot tell where you are.
    const minW = 0.02;
    let lo = this.barLo, hi = this.barHi;
    if (hi - lo < minW) { const mid = (lo + hi) / 2; lo = mid - minW / 2; hi = mid + minW / 2; }
    lo = Math.max(0, Math.min(1 - (hi - lo), lo)); hi = lo + Math.min(hi - lo, 1 - lo);
    t.style.left = `${(lo * 100).toFixed(2)}%`; t.style.width = `${((hi - lo) * 100).toFixed(2)}%`;
    const w = t.firstElementChild as HTMLElement;
    w.hidden = this.zoom <= 1; w.style.left = `${(this.start * 100).toFixed(2)}%`; w.style.width = `${(100 / this.zoom).toFixed(2)}%`;
  }

  /** The span itself moved by `dFrac` of its width (+ = up in frequency): slide the history so old rows stay under their frequencies. */
  shiftSpan(dFrac: number): void {
    const cols = this.cols, rows = this.rows, sx = Math.round(dFrac * cols * this.zoom);
    if (!sx) return;
    const ring = document.createElement('canvas'); ring.width = cols; ring.height = rows;
    const rg = ring.getContext('2d', { alpha: false })!;
    rg.fillStyle = '#000004'; rg.fillRect(0, 0, cols, rows);
    if (Math.abs(sx) < cols) rg.drawImage(this.ring, -sx, 0);
    this.ring = ring; this.ringCtx = rg; this.rowImg = rg.createImageData(cols, 1);
    // The memory is anchored to absolute frequency, so the span moving up means its origin moves up inside it too;
    // then repaint the sliver the shift just exposed from whatever the memory holds there.
    if (this.mem) {
      this.memOrigin += Math.round(dFrac * cols);
      this.recenterMem(cols);
      const w = Math.min(cols, Math.abs(sx));
      this.backfill(rg, sx > 0 ? cols - w : 0, w);
    }
    const peak = new Float32Array(cols);
    for (let x = 0; x < cols; x++) { const from = x + sx; peak[x] = from >= 0 && from < cols ? this.peak[from] : 0; }
    this.peak = peak; this.last = new Float32Array(0);
    const below = rows - this.head;
    this.wfCtx.drawImage(this.ring, 0, this.head, cols, below, 0, 0, cols, below);
    if (this.head > 0) this.wfCtx.drawImage(this.ring, 0, 0, cols, this.head, 0, below, cols, this.head);
    this.overlay(); this.draw();
  }
  /** Display position (0..1) of a full-span fraction, or null when it is outside the window. */
  private toView(frac: number): number | null { const v = (frac - this.start) * this.zoom; return v >= -0.001 && v <= 1.001 ? v : null; }

  /** Wipe the history (a sweep changed range or slice width, so the old rows would mislead). */
  clear(): void {
    this.ringCtx.fillStyle = '#000004'; this.ringCtx.fillRect(0, 0, this.cols, this.rows);
    this.wfCtx.fillStyle = '#000004'; this.wfCtx.fillRect(0, 0, this.cols, this.rows);
    if (this.memCtx) { this.memCtx.fillRect(0, 0, this.memW, this.rows); this.memOrigin = Math.floor((this.memW - this.cols) / 2); }
    this.head = 0; this.filled = 0; this.peak.fill(0); this.last = new Float32Array(0); this.floorDb = NaN;
    this.draw();
  }

  setLabels(labels: AxisLabel[]): void { this.fullLabels = labels; this.applyLabels(); }
  private applyLabels(): void {
    let labels = this.fullLabels;
    if (this.zoom > 1) {
      if (this.labelAt) labels = [0, 0.25, 0.5, 0.75, 1].map(f => [f, this.labelAt!(this.start + f / this.zoom, this.zoom)] as AxisLabel);
      else labels = this.fullLabels.map(([f, t]) => [(f - this.start) * this.zoom, t] as AxisLabel).filter(([f]) => f >= 0 && f <= 1);
    }
    this.axis.innerHTML = labels.map(([f, t]) => `<span style="left:${(f * 100).toFixed(2)}%">${t}</span>`).join('');
  }

  /** Width of the demodulated channel as a fraction of the full span (null hides the shading), centered at `at` (0..1). A zoomed view follows the channel. */
  setChannel(frac: number | null, at = 0.5): void {
    this.channel = frac; this.channelAt = at;
    if (this.zoom <= 1 || frac === null) return;
    // A zoomed view follows the channel, but never while the user is aiming with it: a tap or a wheel notch that
    // nudges the dial must not slide the spectrum under the finger, or the next tap lands somewhere else.
    if (performance.now() - this.lastGesture < 2000) return;
    const v = (at - this.start) * this.zoom;
    if (v >= 0.03 && v <= 0.97) return;
    const margin = 0.2 / this.zoom;                 // scroll the least that brings it back, not a jump to the middle
    this.setView(this.zoom, undefined, undefined, v < 0.5 ? at - margin : at - 1 / this.zoom + margin);
  }
  /** The user is working the waterfall: hold the view still for a moment (tuning from outside the scope calls this too). */
  holdView(): void { this.lastGesture = performance.now(); }

  /** Labels found by the worker's classifier (frac across the span, 0..1 height, text). null = detect locally. */
  setSignals(list: { frac: number; val: number; text: string }[] | null): void { this.signals = list; }

  /** dB scale the incoming 0..1 rows are normalized against (for the spectrum grid labels). */
  setScale(floorDb: number, rangeDb: number): void { this.floorDb = floorDb; this.rangeDb = rangeDb; }

  push(bins: Float32Array): void {
    // Belt and braces for the ResizeObserver: it does not fire while a tab is hidden, so re-check the fit every
    // second or so of rows (a tab that was resized in the background catches up on its first frames).
    if ((++this.pushes & 31) === 0) this.refit(this.host);
    const cols = this.cols;
    // The visible slice is taken on exact fractional bin bounds. Rounding it to whole bins moves the picture
    // against everything drawn from the view fraction — the tuned marker, the channel shading, the peak labels,
    // and the older waterfall rows, which are rescaled exactly when the zoom changes. The error is under a bin
    // of the full span, which is invisible at 1x and several pixels once zoomed in.
    const nb = bins.length;
    const lo = this.start * nb, span = (nb / this.zoom) / cols;      // first bin of the view, bins per column
    let row: Float32Array;
    if (this.zoom === 1 && nb === cols) row = bins;
    else {
      row = this.last.length === cols && this.last !== bins ? this.last : new Float32Array(cols);
      this.resample(bins, row, lo, span);
    }
    this.last = row;
    // The memory takes the WHOLE span at 1× whatever the view is showing, so panning back over it later finds it.
    if (this.memCtx && this.memImg) {
      const mr = this.memRow;
      if (nb === cols) mr.set(bins); else this.resample(bins, mr, 0, nb / cols);
      const md = this.memImg.data;
      for (let x = 0; x < cols; x++) {
        const v = mr[x], li = (v <= 0 ? 0 : v >= 1 ? 255 : (v * 255) | 0) * 4, o = x * 4;
        md[o] = LUT[li]; md[o + 1] = LUT[li + 1]; md[o + 2] = LUT[li + 2]; md[o + 3] = 255;
      }
    }
    const d = this.rowImg.data;
    for (let x = 0; x < cols; x++) {
      const v = row[x];
      const li = (v <= 0 ? 0 : v >= 1 ? 255 : (v * 255) | 0) * 4;
      const o = x * 4;
      d[o] = LUT[li]; d[o + 1] = LUT[li + 1]; d[o + 2] = LUT[li + 2]; d[o + 3] = 255;
      this.peak[x] = v > this.peak[x] ? v : this.peak[x] * 0.985;
    }
    // newest row goes at ring[head], head walks upwards; the visible image is ring[head..) then ring[0..head)
    const now = performance.now();
    for (let k = 0; k < this.rowPx; k++) {
      this.head = (this.head - 1 + this.rows) % this.rows;
      this.ringCtx.putImageData(this.rowImg, 0, this.head);
      // Same row slot in the memory: black right across (this instant was only sampled over the current span —
      // the slot's old contents elsewhere are from `rows` frames ago and must not pose as now), then the span.
      if (this.memCtx && this.memImg) { this.memCtx.fillRect(0, this.head, this.memW, 1); this.memCtx.putImageData(this.memImg, this.memOrigin, this.head); }
      this.stamps[this.head] = now;
      if (this.filled < this.rows) this.filled++;
    }
    const below = this.rows - this.head;
    this.wfCtx.drawImage(this.ring, 0, this.head, cols, below, 0, 0, cols, below);
    if (this.head > 0) this.wfCtx.drawImage(this.ring, 0, 0, cols, this.head, 0, below, cols, this.head);
    this.overlay();
    this.draw();
  }

  /**
   * Redraw the spectrum trace from `bins` WITHOUT laying down a waterfall row. A sweep uses this to paint each
   * slice the instant it is measured, so the trace fills across the span as the radio steps instead of the whole
   * picture jumping once a full pass finishes. The waterfall still gets one row per completed pass, via push().
   */
  setSpectrum(bins: Float32Array): void {
    const cols = this.cols, nb = bins.length;
    if (!nb) return;
    const lo = this.start * nb, span = (nb / this.zoom) / cols;
    const row = new Float32Array(cols);
    this.resample(bins, row, lo, span);
    this.last = row;
    for (let x = 0; x < cols; x++) if (row[x] > this.peak[x]) this.peak[x] = row[x];   // live fill only raises the hold
    this.draw();
  }

  /**
   * Resample `bins` into `out` (one value per column), starting at bin `lo` with `span` bins per column: max-pool
   * when a column covers more than one bin so a narrow carrier never falls between pixels, linear interpolation at
   * the column's center when it covers less.
   */
  private resample(bins: Float32Array, out: Float32Array, lo: number, span: number): void {
    const cols = out.length, nb = bins.length;
    if (span >= 1) {
      for (let x = 0; x < cols; x++) {
        const a = Math.max(0, Math.min(nb - 1, Math.floor(lo + x * span)));
        const b = Math.min(nb, Math.max(a + 1, Math.floor(lo + (x + 1) * span)));
        let m = 0; for (let i = a; i < b; i++) if (bins[i] > m) m = bins[i];
        out[x] = m;
      }
    } else {
      for (let x = 0; x < cols; x++) {
        const p = Math.max(0, Math.min(nb - 1, lo + (x + 0.5) * span - 0.5)), i = Math.floor(p), f = p - i;
        out[x] = i + 1 < nb ? bins[i] * (1 - f) + bins[i + 1] * f : bins[i];
      }
    }
  }

  /** Three spans of memory, within a pixel budget (a phone at 3× dpr must not be handed a 200 MB canvas); none at all when that leaves less than two spans, which would remember nothing beyond the view. */
  private allocMem(cols: number, rows: number): void {
    // Two spans wide (half a span of pan margin each side), within a pixel budget. Two, not three: the canvas is
    // re-allocated and re-drawn on every re-fit, and a three-span sheet at a high device resolution was a ~40 MB
    // allocation that stalled the frame; two spans still cover any realistic pan and halve that cost.
    const w = Math.min(2 * cols, Math.floor(12e6 / Math.max(1, rows)));
    if (w < Math.round(1.5 * cols)) { this.mem = null; this.memCtx = null; this.memW = 0; this.memOrigin = 0; this.memImg = null; this.memRow = new Float32Array(0); return; }
    const c = document.createElement('canvas'); c.width = w; c.height = rows;
    const g = c.getContext('2d', { alpha: false })!; g.fillStyle = '#000004'; g.fillRect(0, 0, w, rows);
    this.mem = c; this.memCtx = g; this.memW = w; this.memOrigin = Math.floor((w - cols) / 2);
    this.memImg = g.createImageData(cols, 1); this.memRow = new Float32Array(cols);
  }
  /** The host was resized: rebuild the memory for the new geometry with the old contents scaled in (same unroll as the ring), the span's origin kept proportional. Reads the OLD cols / rows / head. */
  private refitMem(cols: number, rows: number): void {
    const old = this.mem, oW = this.memW, oRows = this.rows, oHead = this.head, oOrigin = this.memOrigin, oCols = this.cols;
    this.allocMem(cols, rows);
    if (!old || !this.memCtx || !oW) return;
    const ordered = document.createElement('canvas'); ordered.width = oW; ordered.height = oRows;
    const og = ordered.getContext('2d')!;
    const below = oRows - oHead;
    og.drawImage(old, 0, oHead, oW, below, 0, 0, oW, below);
    if (oHead > 0) og.drawImage(old, 0, 0, oW, oHead, 0, below, oW, oHead);
    const k = cols / oCols, g = this.memCtx;
    g.imageSmoothingEnabled = true;
    g.drawImage(ordered, 0, 0, oW, oRows, this.memOrigin - oOrigin * k, 0, oW * k, rows);
  }
  /** Keep the current span inside the memory: when its origin has walked off an edge, slide the memory over by whole spans (a jump past all of it simply starts fresh). */
  private recenterMem(cols: number): void {
    const g = this.memCtx; if (!g || !this.mem) return;
    const w = this.memW;
    let s = 0;
    if (this.memOrigin < 0) s = cols * Math.ceil(-this.memOrigin / cols);
    else if (this.memOrigin + cols > w) s = -cols * Math.ceil((this.memOrigin + cols - w) / cols);
    if (!s) return;
    const c = document.createElement('canvas'); c.width = w; c.height = this.rows;
    const ng = c.getContext('2d', { alpha: false })!; ng.fillStyle = '#000004'; ng.fillRect(0, 0, w, this.rows);
    if (Math.abs(s) < w) ng.drawImage(this.mem, s, 0);
    this.mem = c; this.memCtx = ng; this.memImg = ng.createImageData(cols, 1);
    this.memOrigin = Math.max(0, Math.min(w - cols, this.memOrigin + s));
  }
  /**
   * Repaint ring columns [x0, x0 + w) of `g` from the memory, full height (ring rows and memory rows share the
   * same slot indexing, so row y maps to row y). A ring column is a view fraction, a view fraction is a span
   * fraction through `start` / `zoom`, and a span fraction is a memory column through `memOrigin`.
   */
  private backfill(g: CanvasRenderingContext2D, x0: number, w: number): void {
    if (!this.mem || w <= 0) return;
    const cols = this.cols, rows = this.rows, z = this.zoom;
    const sx = this.memOrigin + (this.start + x0 / cols / z) * cols, sw = w / z;
    const a = Math.max(0, sx), b = Math.min(this.memW, sx + sw);
    if (b <= a) return;
    const prev = g.imageSmoothingEnabled; g.imageSmoothingEnabled = z > 1;      // 1× memory under a zoomed view is upscaled
    g.drawImage(this.mem, a, 0, b - a, rows, x0 + (a - sx) * z, 0, (b - a) * z, rows);
    g.imageSmoothingEnabled = prev;
  }

  /** Channel edges and a seconds ruler drawn over the freshly blitted waterfall. */
  private overlay(): void {
    const g = this.wfCtx, w = this.cols, h = this.rows, dpr = this.ui();
    if (this.channel !== null && this.center) {
      const ca = (this.channelAt - this.start) * this.zoom, cw = this.channel * this.zoom;
      const x0 = Math.round(w * (ca - cw / 2)), x1 = Math.round(w * (ca + cw / 2));
      g.fillStyle = 'rgba(255,255,255,0.05)'; g.fillRect(x0, 0, Math.max(1, x1 - x0), h);
      g.fillStyle = css('--accent') || '#4c8dff'; g.fillRect(x0, 0, 1, h); g.fillRect(x1 - 1, 0, 1, h);
      if (this.adjustable) {                                           // grips: the edges can be dragged to set the filter
        const s = 5 * dpr;
        g.fillStyle = 'rgba(255,255,255,0.7)';
        g.beginPath(); g.moveTo(x0, 6 * dpr); g.lineTo(x0 - s, 6 * dpr + s); g.lineTo(x0, 6 * dpr + 2 * s); g.closePath(); g.fill();
        g.beginPath(); g.moveTo(x1, 6 * dpr); g.lineTo(x1 + s, 6 * dpr + s); g.lineTo(x1, 6 * dpr + 2 * s); g.closePath(); g.fill();
      }
    }
    // time ruler: a tick + label wherever the history crosses a whole interval; the interval is picked from the
    // history's actual pace so labels stay at least ~40 px apart (a sweep row can be several seconds)
    if (this.filled > 2 && this.rows >= 56 * dpr) {                  // a short strip has no room for a ruler
      const now = performance.now();
      const oldest = (now - this.stamps[(this.head + this.filled - 1) % this.rows]) / 1000;
      const secPerPx = Math.max(1e-3, oldest / this.filled);
      const minPx = 40 * dpr;
      let ivl = 5; for (const c of [5, 10, 15, 30, 60, 120, 300, 600]) { ivl = c; if (c / secPerPx >= minPx) break; }
      const label = (s: number) => s >= 120 ? `-${Math.round(s / 60)}m` : `-${s}s`;
      g.fillStyle = 'rgba(255,255,255,0.55)'; g.font = `${Math.round(9 * dpr)}px ui-monospace, Menlo, Consolas, monospace`; g.textAlign = 'left'; g.textBaseline = 'middle';
      let prevMark = -1;
      for (let y = 0; y < this.filled; y++) {
        const mark = Math.floor((now - this.stamps[(this.head + y) % this.rows]) / 1000 / ivl);
        if (prevMark >= 0 && mark !== prevMark && mark > 0) { g.fillRect(0, y, 6 * dpr, 1); g.fillText(label(mark * ivl), 8 * dpr, y); }
        prevMark = mark;
      }
    }
  }

  draw(): void {
    const c = this.sp;
    const cr = c.getBoundingClientRect();
    const cssW = cr.width || c.clientWidth || 300, cssH = cr.height || c.clientHeight || 90;
    if (c.width !== Math.round(cssW * this.dpr) || c.height !== Math.round(cssH * this.dpr)) { c.width = Math.round(cssW * this.dpr); c.height = Math.round(cssH * this.dpr); }
    const dpr = this.ui();
    const g = c.getContext('2d')!;
    const w = c.width, h = c.height;
    const accent = css('--accent') || '#4c8dff', hold = css('--hold') || '#ffaf00', muted = css('--muted') || '#8892a6';
    g.clearRect(0, 0, w, h);
    // dB grid: one line per 10 dB of the worker's range, labeled at the right edge
    g.strokeStyle = 'rgba(255,255,255,0.07)'; g.lineWidth = 1;
    g.fillStyle = muted; g.font = `${Math.round(9 * dpr)}px ui-monospace, Menlo, Consolas, monospace`; g.textAlign = 'right'; g.textBaseline = 'top';
    const steps = Math.max(2, Math.round(this.rangeDb / 10));
    for (let k = 1; k < steps; k++) {
      const y = Math.round(h - (k / steps) * (h - 2)) + 0.5;
      g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke();
      if (!Number.isNaN(this.floorDb)) g.fillText(`${Math.round(this.floorDb + (k / steps) * this.rangeDb)}`, w - 3 * dpr, y + 1);
    }
    if (this.channel !== null && this.center) {
      const ca = (this.channelAt - this.start) * this.zoom, cw = this.channel * this.zoom;
      const x0 = w * (ca - cw / 2), x1 = w * (ca + cw / 2);
      g.fillStyle = 'rgba(255,255,255,0.06)'; g.fillRect(x0, 0, Math.max(1, x1 - x0), h);
    }
    const n = this.cols;
    if (this.last.length >= n) {
      // Column i covers x from i*step to (i+1)*step in the waterfall, so its trace point is the center of that.
      const step = w / n, xAt = (i: number) => (i + 0.5) * step;
      g.beginPath(); g.moveTo(0, h); g.lineTo(0, h - this.last[0] * (h - 2));
      for (let i = 0; i < n; i++) g.lineTo(xAt(i), h - this.last[i] * (h - 2));
      g.lineTo(w, h - this.last[n - 1] * (h - 2)); g.lineTo(w, h); g.closePath();
      const grad = g.createLinearGradient(0, 0, 0, h); grad.addColorStop(0, accent + 'aa'); grad.addColorStop(1, accent + '10');
      g.fillStyle = grad; g.fill();
      g.beginPath();
      for (let i = 0; i < n; i++) { const x = xAt(i), y = h - this.last[i] * (h - 2); if (i === 0) g.moveTo(x, y); else g.lineTo(x, y); }
      g.save(); g.shadowColor = accent; g.shadowBlur = 6 * dpr;
      g.strokeStyle = accent; g.lineWidth = Math.max(1, 1.25 * dpr); g.lineJoin = 'round'; g.stroke();
      g.restore();
      g.beginPath();
      for (let i = 0; i < n; i++) { const x = xAt(i), y = h - this.peak[i] * (h - 2); if (i === 0) g.moveTo(x, y); else g.lineTo(x, y); }
      g.strokeStyle = hold + '99'; g.lineWidth = 1; g.stroke();
      this.annotate(g, w, h, step);
    }
    // A full-height vertical line with a dark casing under it, so it reads whether it crosses black grid or the
    // tuned signal's own accent-filled trace. Without the casing an accent line vanishes into the accent fill of
    // a strong centered station — which is what made the band look "incomplete" exactly over the signal you tuned.
    const vline = (x: number, color: string, lw: number) => {
      const xr = Math.round(x) + 0.5;
      g.strokeStyle = 'rgba(0,0,0,0.6)'; g.lineWidth = lw + 2.5 * dpr;
      g.beginPath(); g.moveTo(xr, 0); g.lineTo(xr, h); g.stroke();
      g.strokeStyle = color; g.lineWidth = lw;
      g.beginPath(); g.moveTo(xr, 0); g.lineTo(xr, h); g.stroke();
    };
    // Channel edges drawn LAST so the tuned signal's own filled trace can't paint over them.
    if (this.channel !== null && this.center) {
      const ca = (this.channelAt - this.start) * this.zoom, cw = this.channel * this.zoom;
      vline(w * (ca - cw / 2), accent, Math.max(1.25, 1.1 * dpr));
      vline(w * (ca + cw / 2), accent, Math.max(1.25, 1.1 * dpr));
    }
    const cx = this.toView(0.5);
    if (this.center && cx !== null) vline(w * cx, accent + 'aa', Math.max(1, 0.8 * dpr));
  }

  /**
   * Label the signals: the peak-hold trace is box-smoothed over ~1/80 of the span so a wide FM station reads as one
   * hump with its label on the center rather than on whichever modulation spike is tallest this frame; humps at
   * least 6 dB over the median floor and 1/30 of the span apart get a label, strongest 8.
   */
  private annotate(g: CanvasRenderingContext2D, w: number, h: number, step: number): void {
    if (this.signals) { this.drawLabels(g, w, h, this.signals.map(s => [this.toView(s.frac), s] as const).filter(([v]) => v !== null).map(([v, s]) => [v! * w, h - s.val * (h - 2), s.text] as [number, number, string])); return; }
    if (!this.labelAt || Number.isNaN(this.floorDb)) return;
    const v = this.peak, n = v.length;
    if (n < 8) return;
    const rad = Math.max(2, Math.round(n / 80)), sep = Math.max(3, Math.round(n / 30));
    const ps = this.prefix.length === n + 1 ? this.prefix : (this.prefix = new Float64Array(n + 1));
    for (let i = 0; i < n; i++) ps[i + 1] = ps[i] + v[i];
    const sm = this.smooth.length === n ? this.smooth : (this.smooth = new Float32Array(n));
    for (let i = 0; i < n; i++) { const a = Math.max(0, i - rad), b = Math.min(n, i + rad + 1); sm[i] = (ps[b] - ps[a]) / (b - a); }
    const min = (6 + 4) / this.rangeDb; // the median floor sits 4 dB up the scale
    const cands: [number, number][] = [];
    for (let i = 1; i < n - 1; i++) {
      if (sm[i] < min || sm[i] < sm[i - 1] || sm[i] < sm[i + 1]) continue;
      let best = true;
      for (let k = Math.max(0, i - sep); k < Math.min(n, i + sep); k++) if (sm[k] > sm[i]) { best = false; break; }
      if (!best) continue;
      let pk = 0; for (let k = Math.max(0, i - rad); k < Math.min(n, i + rad + 1); k++) if (v[k] > pk) pk = v[k];
      cands.push([i, pk]);
    }
    cands.sort((a, b) => b[1] - a[1]);
    const dpr = this.ui();
    g.font = `${Math.round(9 * dpr)}px ui-monospace, Menlo, Consolas, monospace`; g.textBaseline = 'bottom';
    this.drawLabels(g, w, h, cands.slice(0, 8).map(([i, val]) => [(i + 0.5) * step, h - val * (h - 2), `${this.labelAt!(this.start + ((i + 0.5) / n) / this.zoom, this.zoom)} ${Math.round(this.floorDb + val * this.rangeDb)}dB`] as [number, number, string]));
  }
  private drawLabels(g: CanvasRenderingContext2D, w: number, h: number, items: [number, number, string][]): void {
    const dpr = this.ui(), hold = css('--hold') || '#ffaf00';
    g.font = `${Math.round(9 * dpr)}px ui-monospace, Menlo, Consolas, monospace`; g.textBaseline = 'bottom';
    let row = 0, lastRight = -1e9;
    for (const [x, y, text] of items) {
      const right = x > w * 0.85;
      g.textAlign = right ? 'right' : 'left';
      const tw = g.measureText(text).width;
      // stagger labels that would overlap the previous one
      row = x - lastRight < tw + 6 * dpr && x - lastRight > -tw ? (row + 1) % 3 : 0;
      const tx = right ? x - 3 * dpr : x + 3 * dpr, ty = Math.max(11 * dpr * (row + 1), y - 2 * dpr - row * 11 * dpr);
      g.fillStyle = 'rgba(0,0,0,0.55)'; g.fillRect(right ? tx - tw - 2 * dpr : tx - 2 * dpr, ty - 10 * dpr, tw + 4 * dpr, 11 * dpr);
      g.fillStyle = hold; g.fillText(text, tx, ty);
      g.fillRect(x - dpr / 2, y, dpr, h - y);
      lastRight = right ? x : x + tw;
    }
  }
}

/** Axis labels for a span centered on centerHz with width spanHz. */
export function centeredLabels(centerHz: number, spanHz: number): AxisLabel[] {
  return [0, 0.25, 0.5, 0.75, 1].map(f => [f, ((centerHz + (f - 0.5) * spanHz) / 1e6).toFixed(3)]);
}
/** Axis labels for an absolute range. */
export function rangeLabels(startHz: number, endHz: number, n = 5): AxisLabel[] {
  const out: AxisLabel[] = [];
  for (let k = 0; k < n; k++) {
    const f = k / (n - 1);
    const hz = startHz + (endHz - startHz) * f;
    out.push([f, endHz - startHz >= 50e6 ? (hz / 1e6).toFixed(0) : (hz / 1e6).toFixed(2)]);
  }
  return out;
}
/**
 * Downsample a sweep row (steps × 256 dB) to cols columns by max, normalized like the live scope: the median is
 * the floor (sitting 4 dB up the scale) and the display range is 40 dB, so sweeps and the main waterfall read the
 * same way.
 */
export function rowToSpec(row: Float32Array, cols: number): Float32Array {
  const out = new Float32Array(cols);
  if (!row.length) return out;
  const sorted = Float32Array.from(row).sort();
  const floor = sorted[sorted.length >> 1] - 4;
  for (let c = 0; c < cols; c++) {
    const a = Math.floor(c * row.length / cols), b = Math.max(a + 1, Math.floor((c + 1) * row.length / cols));
    let peak = -999;
    for (let i = a; i < Math.min(b, row.length); i++) if (row[i] > peak) peak = row[i];
    out[c] = Math.min(1, Math.max(0, (peak - floor) / 30));
  }
  return out;
}
