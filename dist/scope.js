function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
const LUT = (() => {
    const stops = [
        [0.00, 0, 0, 4], [0.13, 31, 12, 72], [0.25, 85, 15, 109], [0.38, 136, 34, 106], [0.50, 186, 54, 85],
        [0.63, 227, 89, 51], [0.75, 249, 140, 10], [0.88, 249, 201, 50], [1.00, 252, 255, 164],
    ];
    const lut = new Uint8ClampedArray(256 * 4);
    for (let i = 0; i < 256; i++) {
        const t = i / 255;
        let k = 0;
        while (k < stops.length - 2 && t > stops[k + 1][0])
            k++;
        const [t0, r0, g0, b0] = stops[k], [t1, r1, g1, b1] = stops[k + 1];
        const f = Math.min(1, Math.max(0, (t - t0) / (t1 - t0)));
        lut[i * 4] = r0 + (r1 - r0) * f;
        lut[i * 4 + 1] = g0 + (g1 - g0) * f;
        lut[i * 4 + 2] = b0 + (b1 - b0) * f;
        lut[i * 4 + 3] = 255;
    }
    return lut;
})();
export class Scope {
    static measure(el, fallback) {
        const r = el.getBoundingClientRect();
        return r.width > 0 ? r.width : fallback;
    }
    ui() {
        const cw = this.wf.clientWidth;
        if (!cw)
            return this.dpr;
        const r = this.wf.getBoundingClientRect();
        return r.width > 0 ? this.dpr * (r.width / cw) : this.dpr;
    }
    fitCols(host) { return Math.max(256, Math.min(8192, Math.round(Scope.measure(host, 512) * this.dpr))); }
    fitRows(fallback) { const r = this.wf.getBoundingClientRect(); return Math.max(64, Math.min(4096, Math.round((r.height > 0 ? r.height : fallback) * this.dpr))); }
    constructor(host, cols, opts = {}) {
        this.mem = null;
        this.memCtx = null;
        this.memW = 0;
        this.memOrigin = 0;
        this.memRow = new Float32Array(0);
        this.memImg = null;
        this.last = new Float32Array(0);
        this.head = 0;
        this.filled = 0;
        this.floorDb = NaN;
        this.rangeDb = 40;
        this.channel = null;
        this.channelAt = 0.5;
        this.pushes = 0;
        this.signals = null;
        this.prefix = new Float64Array(0);
        this.smooth = new Float32Array(0);
        this.zoom = 1;
        this.start = 0;
        this.fullLabels = [];
        this.zoomText = null;
        this.lastGesture = 0;
        this.thumb = null;
        this.barLabels = [];
        this.barLo = 0;
        this.barHi = 1;
        this.spanText = '1×';
        this.dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
        this.host = host;
        host.classList.add('scope');
        host.innerHTML = `<canvas class="wf"></canvas><canvas class="sp" style="height:${opts.spectrumHeight ?? 90}px"></canvas><div class="axis"></div>`;
        this.wf = host.querySelector('.wf');
        this.sp = host.querySelector('.sp');
        this.axis = host.querySelector('.axis');
        this.fixedCols = cols > 0;
        this.cols = cols || this.fitCols(host);
        this.rows = this.fitRows(opts.rows ?? 160);
        this.wf.width = this.cols;
        this.wf.height = this.rows;
        this.wfCtx = this.wf.getContext('2d', { alpha: false });
        this.ring = document.createElement('canvas');
        this.ring.width = this.cols;
        this.ring.height = this.rows;
        this.ringCtx = this.ring.getContext('2d', { alpha: false });
        this.ringCtx.fillStyle = '#000004';
        this.ringCtx.fillRect(0, 0, this.cols, this.rows);
        this.wfCtx.fillStyle = '#000004';
        this.wfCtx.fillRect(0, 0, this.cols, this.rows);
        this.rowImg = this.ringCtx.createImageData(this.cols, 1);
        this.allocMem(this.cols, this.rows);
        this.peak = new Float32Array(this.cols);
        this.stamps = new Float64Array(this.rows);
        this.labelAt = opts.labelAt;
        this.adjustable = !!opts.onChannel;
        this.rowPx = Math.max(1, Math.floor((opts.rowPx ?? 1) * this.dpr));
        this.center = opts.center ?? true;
        let lastFit = 0, trailing = 0;
        const fitNow = () => { lastFit = performance.now(); if (trailing) {
            clearTimeout(trailing);
            trailing = 0;
        } this.refit(host); };
        const onSize = () => { const dt = performance.now() - lastFit; if (dt >= 70)
            fitNow();
        else if (!trailing)
            trailing = window.setTimeout(fitNow, 70 - dt); };
        if (typeof ResizeObserver !== 'undefined') {
            const ro = new ResizeObserver(onSize);
            ro.observe(host);
        }
        window.addEventListener('resize', onSize);
        const zc = document.createElement('div');
        zc.className = 'zoomctl';
        zc.innerHTML = '<button data-c title="back to the tuned channel">⌖</button><button data-z="-" title="zoom out">−</button><span>1×</span><button data-z="+" title="zoom in">+</button>';
        host.appendChild(zc);
        this.zoomText = zc.querySelector('span');
        zc.querySelector('[data-c]').addEventListener('click', (e) => { e.stopPropagation(); opts.onCenter?.(); });
        zc.querySelector('[data-z="-"]').addEventListener('click', (e) => { e.stopPropagation(); if (this.zoom <= 1) {
            opts.onSpanStep?.(-1);
            return;
        } this.setView(this.zoom / 2); });
        zc.querySelector('[data-z="+"]').addEventListener('click', (e) => { e.stopPropagation(); if (this.zoom <= 1 && opts.onSpanStep?.(1))
            return; this.setView(this.zoom * 2); });
        zc.addEventListener('pointerdown', e => e.stopPropagation());
        if (opts.onSlide) {
            const bar = document.createElement('div');
            bar.className = 'spanbar';
            bar.innerHTML = '<span class="l"></span><span class="r"></span><div class="thumb"><i></i></div>';
            host.appendChild(bar);
            host.classList.add('hasbar');
            this.thumb = bar.querySelector('.thumb');
            this.barLabels = [...bar.querySelectorAll('span')];
            const barFrac = (x) => { const r = bar.getBoundingClientRect(); return r.width > 0 ? Math.min(1, Math.max(0, (x - r.left) / r.width)) : 0.5; };
            let grab = 0, dragging = false, lastF = 0.5;
            bar.addEventListener('pointerdown', (ev) => {
                if (ev.pointerType === 'mouse' && ev.button !== 0)
                    return;
                ev.preventDefault();
                ev.stopPropagation();
                try {
                    bar.setPointerCapture(ev.pointerId);
                }
                catch { }
                const f = barFrac(ev.clientX), c = (this.barLo + this.barHi) / 2;
                grab = f >= this.barLo - 0.01 && f <= this.barHi + 0.01 ? f - c : 0;
                dragging = true;
                lastF = f - grab;
                bar.classList.add('drag');
                if (grab === 0)
                    opts.onSlide(lastF, false);
            });
            bar.addEventListener('pointermove', (ev) => { if (!dragging)
                return; lastF = barFrac(ev.clientX) - grab; opts.onSlide(lastF, false); });
            const end = () => { if (!dragging)
                return; dragging = false; bar.classList.remove('drag'); opts.onSlide(lastF, true); };
            bar.addEventListener('pointerup', end);
            bar.addEventListener('pointercancel', end);
            this.drawBar();
        }
        const dispFrac = (clientX) => { const r = this.wf.getBoundingClientRect(); return Math.min(1, Math.max(0, (clientX - r.left) / r.width)); };
        host.addEventListener('wheel', (ev) => {
            if (!ev.ctrlKey && !ev.metaKey)
                return;
            ev.preventDefault();
            if (this.zoom <= 1 && ev.deltaY > 0) {
                opts.onSpanStep?.(-1);
                return;
            }
            if (this.zoom <= 1 && ev.deltaY < 0 && opts.onSpanStep?.(1))
                return;
            const f = this.start + dispFrac(ev.clientX) / this.zoom;
            const z = ev.deltaY < 0 ? this.zoom * 2 : this.zoom / 2;
            this.setView(z, f, dispFrac(ev.clientX));
        }, { passive: false });
        const guide = document.createElement('div');
        guide.className = 'guide';
        guide.hidden = true;
        host.appendChild(guide);
        const pointers = new Map();
        let active = false, panning = false, panStart = 0, panFrom = 0, pinchDist = 0, pinchZoom = 1, pinchMid = 0, pinchStart = 0;
        let spanDrag = false, spanDelta = 0;
        let edge = null;
        const edgeHit = (clientX) => {
            if (this.channel === null || !opts.onChannel)
                return null;
            const r = host.getBoundingClientRect(), x = dispFrac(clientX), tol = 8 / Math.max(1, r.width);
            const ca = (this.channelAt - this.start) * this.zoom, cw = this.channel * this.zoom;
            if (Math.abs(x - (ca + cw / 2)) < tol)
                return 'hi';
            if (Math.abs(x - (ca - cw / 2)) < tol)
                return 'lo';
            return null;
        };
        const show = (f) => { guide.hidden = false; guide.style.left = `${(f * 100).toFixed(2)}%`; opts.onPreview?.(this.start + f / this.zoom); };
        const cancel = () => { active = false; guide.hidden = true; opts.onPreview?.(null); };
        const down = (ev) => {
            if (ev.pointerType === 'mouse' && ev.button !== 0)
                return;
            this.lastGesture = performance.now();
            try {
                ev.currentTarget.setPointerCapture(ev.pointerId);
            }
            catch { }
            pointers.set(ev.pointerId, ev.clientX);
            if (pointers.size === 2) {
                cancel();
                active = false;
                panning = false;
                const [a, b] = [...pointers.values()];
                pinchDist = Math.max(8, Math.abs(a - b));
                pinchZoom = this.zoom;
                pinchMid = dispFrac((a + b) / 2);
                pinchStart = this.start;
                spanDrag = this.zoom <= 1.001 && !!opts.onDragSpan;
                spanDelta = 0;
                return;
            }
            if (ev.shiftKey && this.zoom > 1) {
                panning = true;
                panStart = dispFrac(ev.clientX);
                panFrom = this.start;
                return;
            }
            edge = edgeHit(ev.clientX);
            if (edge)
                return;
            if (!opts.onTap)
                return;
            active = true;
            show(dispFrac(ev.clientX));
        };
        const move = (ev) => {
            if (pointers.has(ev.pointerId))
                pointers.set(ev.pointerId, ev.clientX);
            if (pointers.size === 2) {
                const [a, b] = [...pointers.values()];
                const z = Math.min(32, Math.max(1, pinchZoom * Math.abs(a - b) / pinchDist));
                const mid = dispFrac((a + b) / 2);
                if (spanDrag) {
                    if (z > 1.05) {
                        spanDrag = false;
                    }
                    else {
                        spanDelta = mid - pinchMid;
                        opts.onDragSpan(spanDelta, false);
                        return;
                    }
                }
                const under = pinchStart + pinchMid / pinchZoom;
                this.setView(z, under, mid);
                return;
            }
            if (panning) {
                this.setView(this.zoom, undefined, undefined, panFrom - (dispFrac(ev.clientX) - panStart) / this.zoom);
                return;
            }
            if (edge && this.channel !== null) {
                const f = this.start + dispFrac(ev.clientX) / this.zoom;
                let lo = this.channelAt - this.channel / 2, hi = this.channelAt + this.channel / 2;
                if (edge === 'lo')
                    lo = Math.min(f, hi - 0.0005);
                else
                    hi = Math.max(f, lo + 0.0005);
                opts.onChannel(lo, hi, edge);
                return;
            }
            if (pointers.size === 0) {
                const h = edgeHit(ev.clientX);
                ev.currentTarget.style.cursor = h ? 'ew-resize' : opts.onTap ? 'crosshair' : 'default';
            }
            if (active)
                show(dispFrac(ev.clientX));
        };
        const up = (ev) => {
            pointers.delete(ev.pointerId);
            this.lastGesture = performance.now();
            if (spanDrag && pointers.size < 2) {
                opts.onDragSpan?.(spanDelta, true);
                spanDrag = false;
                spanDelta = 0;
                return;
            }
            if (edge) {
                edge = null;
                return;
            }
            if (panning) {
                if (pointers.size === 0)
                    panning = false;
                return;
            }
            if (!active)
                return;
            const f = dispFrac(ev.clientX);
            cancel();
            if (pointers.size === 0)
                opts.onTap?.(this.start + f / this.zoom);
        };
        const lost = (ev) => {
            pointers.delete(ev.pointerId);
            if (spanDrag && pointers.size < 2) {
                opts.onDragSpan?.(spanDelta, true);
                spanDrag = false;
                spanDelta = 0;
            }
            panning = false;
            edge = null;
            cancel();
        };
        for (const el of [this.wf, this.sp]) {
            el.addEventListener('pointerdown', down);
            el.addEventListener('pointermove', move);
            el.addEventListener('pointerup', up);
            el.addEventListener('pointercancel', lost);
            el.style.touchAction = opts.onTap ? 'pan-y' : 'pan-y';
            el.style.cursor = opts.onTap ? 'crosshair' : 'default';
        }
        this.draw();
    }
    refit(host) {
        if (!host.isConnected)
            return;
        const cols = this.fixedCols ? this.cols : this.fitCols(host);
        const rows = this.fitRows(this.rows / this.dpr);
        if (cols === this.cols && rows === this.rows) {
            this.draw();
            return;
        }
        const ordered = document.createElement('canvas');
        ordered.width = this.cols;
        ordered.height = this.rows;
        const og = ordered.getContext('2d');
        const below = this.rows - this.head;
        og.drawImage(this.ring, 0, this.head, this.cols, below, 0, 0, this.cols, below);
        if (this.head > 0)
            og.drawImage(this.ring, 0, 0, this.cols, this.head, 0, below, this.cols, this.head);
        const ring = document.createElement('canvas');
        ring.width = cols;
        ring.height = rows;
        const rg = ring.getContext('2d', { alpha: false });
        rg.fillStyle = '#000004';
        rg.fillRect(0, 0, cols, rows);
        rg.imageSmoothingEnabled = true;
        rg.drawImage(ordered, 0, 0, this.cols, this.rows, 0, 0, cols, rows);
        const stamps = new Float64Array(rows);
        for (let y = 0; y < rows; y++)
            stamps[y] = this.stamps[(this.head + Math.min(this.rows - 1, Math.floor(y * this.rows / rows))) % this.rows];
        const peak = new Float32Array(cols);
        for (let x = 0; x < cols; x++)
            peak[x] = this.peak[Math.min(this.cols - 1, Math.floor(x * this.cols / cols))];
        try {
            this.refitMem(cols, rows);
        }
        catch {
            this.allocMem(cols, rows);
        }
        this.filled = Math.min(rows, Math.round(this.filled * rows / this.rows));
        this.cols = cols;
        this.rows = rows;
        this.head = 0;
        this.ring = ring;
        this.ringCtx = rg;
        this.stamps = stamps;
        this.peak = peak;
        this.wf.width = cols;
        this.wf.height = rows;
        this.rowImg = this.ringCtx.createImageData(cols, 1);
        this.last = new Float32Array(0);
        this.wfCtx.drawImage(this.ring, 0, 0);
        this.overlay();
        this.draw();
        this.onResize?.(this.bins);
    }
    get cssWidth() { return this.wf.clientWidth || 1; }
    get bins() { return Math.min(8192, this.cols * this.zoom); }
    setView(zoom, keep, at, startFrac) {
        const oldStart = this.start, oldZoom = this.zoom;
        zoom = Math.min(32, Math.max(1, zoom));
        let start = startFrac ?? (keep !== undefined ? keep - (at ?? 0.5) / zoom : oldStart + 0.5 / oldZoom - 0.5 / zoom);
        start = Math.min(1 - 1 / zoom, Math.max(0, start));
        if (zoom === oldZoom && Math.abs(start - oldStart) < 1e-6)
            return;
        this.zoom = zoom;
        this.start = start;
        const cols = this.cols, rows = this.rows;
        const sx = (start - oldStart) * oldZoom * cols, sw = cols * oldZoom / zoom;
        const ring = document.createElement('canvas');
        ring.width = cols;
        ring.height = rows;
        const rg = ring.getContext('2d', { alpha: false });
        rg.fillStyle = '#000004';
        rg.fillRect(0, 0, cols, rows);
        rg.imageSmoothingEnabled = zoom < oldZoom;
        this.backfill(rg, 0, cols);
        const x0 = Math.max(0, sx), x1 = Math.min(cols, sx + sw);
        if (x1 > x0)
            rg.drawImage(this.ring, x0, 0, x1 - x0, rows, (x0 - sx) * cols / sw, 0, (x1 - x0) * cols / sw, rows);
        this.ring = ring;
        this.ringCtx = rg;
        this.rowImg = rg.createImageData(cols, 1);
        const peak = new Float32Array(cols);
        for (let x = 0; x < cols; x++) {
            const src = Math.floor(sx + (x + 0.5) * sw / cols);
            peak[x] = src >= 0 && src < cols ? this.peak[src] : 0;
        }
        this.peak = peak;
        this.last = new Float32Array(0);
        this.host.classList.toggle('zoomed', zoom > 1);
        this.drawBar();
        this.applyLabels();
        this.onResize?.(this.bins);
        const below = rows - this.head;
        this.wfCtx.drawImage(this.ring, 0, this.head, cols, below, 0, 0, cols, below);
        if (this.head > 0)
            this.wfCtx.drawImage(this.ring, 0, 0, cols, this.head, 0, below, cols, this.head);
        this.overlay();
        this.draw();
    }
    setSpanBar(lo, hi, left, right, spanText) {
        this.barLo = lo;
        this.barHi = hi;
        this.spanText = spanText;
        if (this.barLabels.length === 2) {
            this.barLabels[0].textContent = left;
            this.barLabels[1].textContent = right;
        }
        this.drawBar();
    }
    drawBar() {
        if (this.zoomText)
            this.zoomText.textContent = this.zoom > 1 ? `${this.zoom}×` : this.spanText;
        const t = this.thumb;
        if (!t)
            return;
        const minW = 0.02;
        let lo = this.barLo, hi = this.barHi;
        if (hi - lo < minW) {
            const mid = (lo + hi) / 2;
            lo = mid - minW / 2;
            hi = mid + minW / 2;
        }
        lo = Math.max(0, Math.min(1 - (hi - lo), lo));
        hi = lo + Math.min(hi - lo, 1 - lo);
        t.style.left = `${(lo * 100).toFixed(2)}%`;
        t.style.width = `${((hi - lo) * 100).toFixed(2)}%`;
        const w = t.firstElementChild;
        w.hidden = this.zoom <= 1;
        w.style.left = `${(this.start * 100).toFixed(2)}%`;
        w.style.width = `${(100 / this.zoom).toFixed(2)}%`;
    }
    shiftSpan(dFrac) {
        const cols = this.cols, rows = this.rows, sx = Math.round(dFrac * cols * this.zoom);
        if (!sx)
            return;
        const ring = document.createElement('canvas');
        ring.width = cols;
        ring.height = rows;
        const rg = ring.getContext('2d', { alpha: false });
        rg.fillStyle = '#000004';
        rg.fillRect(0, 0, cols, rows);
        if (Math.abs(sx) < cols)
            rg.drawImage(this.ring, -sx, 0);
        this.ring = ring;
        this.ringCtx = rg;
        this.rowImg = rg.createImageData(cols, 1);
        if (this.mem) {
            this.memOrigin += Math.round(dFrac * cols);
            this.recenterMem(cols);
            const w = Math.min(cols, Math.abs(sx));
            this.backfill(rg, sx > 0 ? cols - w : 0, w);
        }
        const peak = new Float32Array(cols);
        for (let x = 0; x < cols; x++) {
            const from = x + sx;
            peak[x] = from >= 0 && from < cols ? this.peak[from] : 0;
        }
        this.peak = peak;
        this.last = new Float32Array(0);
        const below = rows - this.head;
        this.wfCtx.drawImage(this.ring, 0, this.head, cols, below, 0, 0, cols, below);
        if (this.head > 0)
            this.wfCtx.drawImage(this.ring, 0, 0, cols, this.head, 0, below, cols, this.head);
        this.overlay();
        this.draw();
    }
    toView(frac) { const v = (frac - this.start) * this.zoom; return v >= -0.001 && v <= 1.001 ? v : null; }
    clear() {
        this.ringCtx.fillStyle = '#000004';
        this.ringCtx.fillRect(0, 0, this.cols, this.rows);
        this.wfCtx.fillStyle = '#000004';
        this.wfCtx.fillRect(0, 0, this.cols, this.rows);
        if (this.memCtx) {
            this.memCtx.fillRect(0, 0, this.memW, this.rows);
            this.memOrigin = Math.floor((this.memW - this.cols) / 2);
        }
        this.head = 0;
        this.filled = 0;
        this.peak.fill(0);
        this.last = new Float32Array(0);
        this.floorDb = NaN;
        this.draw();
    }
    setLabels(labels) { this.fullLabels = labels; this.applyLabels(); }
    applyLabels() {
        let labels = this.fullLabels;
        if (this.zoom > 1) {
            if (this.labelAt)
                labels = [0, 0.25, 0.5, 0.75, 1].map(f => [f, this.labelAt(this.start + f / this.zoom, this.zoom)]);
            else
                labels = this.fullLabels.map(([f, t]) => [(f - this.start) * this.zoom, t]).filter(([f]) => f >= 0 && f <= 1);
        }
        this.axis.innerHTML = labels.map(([f, t]) => `<span style="left:${(f * 100).toFixed(2)}%">${t}</span>`).join('');
    }
    setChannel(frac, at = 0.5) {
        this.channel = frac;
        this.channelAt = at;
        if (this.zoom <= 1 || frac === null)
            return;
        if (performance.now() - this.lastGesture < 2000)
            return;
        const v = (at - this.start) * this.zoom;
        if (v >= 0.03 && v <= 0.97)
            return;
        const margin = 0.2 / this.zoom;
        this.setView(this.zoom, undefined, undefined, v < 0.5 ? at - margin : at - 1 / this.zoom + margin);
    }
    holdView() { this.lastGesture = performance.now(); }
    setSignals(list) { this.signals = list; }
    setScale(floorDb, rangeDb) { this.floorDb = floorDb; this.rangeDb = rangeDb; }
    push(bins) {
        if ((++this.pushes & 31) === 0)
            this.refit(this.host);
        const cols = this.cols;
        const nb = bins.length;
        const lo = this.start * nb, span = (nb / this.zoom) / cols;
        let row;
        if (this.zoom === 1 && nb === cols)
            row = bins;
        else {
            row = this.last.length === cols && this.last !== bins ? this.last : new Float32Array(cols);
            this.resample(bins, row, lo, span);
        }
        this.last = row;
        if (this.memCtx && this.memImg) {
            const mr = this.memRow;
            if (nb === cols)
                mr.set(bins);
            else
                this.resample(bins, mr, 0, nb / cols);
            const md = this.memImg.data;
            for (let x = 0; x < cols; x++) {
                const v = mr[x], li = (v <= 0 ? 0 : v >= 1 ? 255 : (v * 255) | 0) * 4, o = x * 4;
                md[o] = LUT[li];
                md[o + 1] = LUT[li + 1];
                md[o + 2] = LUT[li + 2];
                md[o + 3] = 255;
            }
        }
        const d = this.rowImg.data;
        for (let x = 0; x < cols; x++) {
            const v = row[x];
            const li = (v <= 0 ? 0 : v >= 1 ? 255 : (v * 255) | 0) * 4;
            const o = x * 4;
            d[o] = LUT[li];
            d[o + 1] = LUT[li + 1];
            d[o + 2] = LUT[li + 2];
            d[o + 3] = 255;
            this.peak[x] = v > this.peak[x] ? v : this.peak[x] * 0.985;
        }
        const now = performance.now();
        for (let k = 0; k < this.rowPx; k++) {
            this.head = (this.head - 1 + this.rows) % this.rows;
            this.ringCtx.putImageData(this.rowImg, 0, this.head);
            if (this.memCtx && this.memImg) {
                this.memCtx.fillRect(0, this.head, this.memW, 1);
                this.memCtx.putImageData(this.memImg, this.memOrigin, this.head);
            }
            this.stamps[this.head] = now;
            if (this.filled < this.rows)
                this.filled++;
        }
        const below = this.rows - this.head;
        this.wfCtx.drawImage(this.ring, 0, this.head, cols, below, 0, 0, cols, below);
        if (this.head > 0)
            this.wfCtx.drawImage(this.ring, 0, 0, cols, this.head, 0, below, cols, this.head);
        this.overlay();
        this.draw();
    }
    setSpectrum(bins) {
        const cols = this.cols, nb = bins.length;
        if (!nb)
            return;
        const lo = this.start * nb, span = (nb / this.zoom) / cols;
        const row = new Float32Array(cols);
        this.resample(bins, row, lo, span);
        this.last = row;
        for (let x = 0; x < cols; x++)
            if (row[x] > this.peak[x])
                this.peak[x] = row[x];
        this.draw();
    }
    resample(bins, out, lo, span) {
        const cols = out.length, nb = bins.length;
        if (span >= 1) {
            for (let x = 0; x < cols; x++) {
                const a = Math.max(0, Math.min(nb - 1, Math.floor(lo + x * span)));
                const b = Math.min(nb, Math.max(a + 1, Math.floor(lo + (x + 1) * span)));
                let m = 0;
                for (let i = a; i < b; i++)
                    if (bins[i] > m)
                        m = bins[i];
                out[x] = m;
            }
        }
        else {
            for (let x = 0; x < cols; x++) {
                const p = Math.max(0, Math.min(nb - 1, lo + (x + 0.5) * span - 0.5)), i = Math.floor(p), f = p - i;
                out[x] = i + 1 < nb ? bins[i] * (1 - f) + bins[i + 1] * f : bins[i];
            }
        }
    }
    allocMem(cols, rows) {
        const w = Math.min(2 * cols, Math.floor(12e6 / Math.max(1, rows)));
        if (w < Math.round(1.5 * cols)) {
            this.mem = null;
            this.memCtx = null;
            this.memW = 0;
            this.memOrigin = 0;
            this.memImg = null;
            this.memRow = new Float32Array(0);
            return;
        }
        const c = document.createElement('canvas');
        c.width = w;
        c.height = rows;
        const g = c.getContext('2d', { alpha: false });
        g.fillStyle = '#000004';
        g.fillRect(0, 0, w, rows);
        this.mem = c;
        this.memCtx = g;
        this.memW = w;
        this.memOrigin = Math.floor((w - cols) / 2);
        this.memImg = g.createImageData(cols, 1);
        this.memRow = new Float32Array(cols);
    }
    refitMem(cols, rows) {
        const old = this.mem, oW = this.memW, oRows = this.rows, oHead = this.head, oOrigin = this.memOrigin, oCols = this.cols;
        this.allocMem(cols, rows);
        if (!old || !this.memCtx || !oW)
            return;
        const ordered = document.createElement('canvas');
        ordered.width = oW;
        ordered.height = oRows;
        const og = ordered.getContext('2d');
        const below = oRows - oHead;
        og.drawImage(old, 0, oHead, oW, below, 0, 0, oW, below);
        if (oHead > 0)
            og.drawImage(old, 0, 0, oW, oHead, 0, below, oW, oHead);
        const k = cols / oCols, g = this.memCtx;
        g.imageSmoothingEnabled = true;
        g.drawImage(ordered, 0, 0, oW, oRows, this.memOrigin - oOrigin * k, 0, oW * k, rows);
    }
    recenterMem(cols) {
        const g = this.memCtx;
        if (!g || !this.mem)
            return;
        const w = this.memW;
        let s = 0;
        if (this.memOrigin < 0)
            s = cols * Math.ceil(-this.memOrigin / cols);
        else if (this.memOrigin + cols > w)
            s = -cols * Math.ceil((this.memOrigin + cols - w) / cols);
        if (!s)
            return;
        const c = document.createElement('canvas');
        c.width = w;
        c.height = this.rows;
        const ng = c.getContext('2d', { alpha: false });
        ng.fillStyle = '#000004';
        ng.fillRect(0, 0, w, this.rows);
        if (Math.abs(s) < w)
            ng.drawImage(this.mem, s, 0);
        this.mem = c;
        this.memCtx = ng;
        this.memImg = ng.createImageData(cols, 1);
        this.memOrigin = Math.max(0, Math.min(w - cols, this.memOrigin + s));
    }
    backfill(g, x0, w) {
        if (!this.mem || w <= 0)
            return;
        const cols = this.cols, rows = this.rows, z = this.zoom;
        const sx = this.memOrigin + (this.start + x0 / cols / z) * cols, sw = w / z;
        const a = Math.max(0, sx), b = Math.min(this.memW, sx + sw);
        if (b <= a)
            return;
        const prev = g.imageSmoothingEnabled;
        g.imageSmoothingEnabled = z > 1;
        g.drawImage(this.mem, a, 0, b - a, rows, x0 + (a - sx) * z, 0, (b - a) * z, rows);
        g.imageSmoothingEnabled = prev;
    }
    overlay() {
        const g = this.wfCtx, w = this.cols, h = this.rows, dpr = this.ui();
        if (this.channel !== null && this.center) {
            const ca = (this.channelAt - this.start) * this.zoom, cw = this.channel * this.zoom;
            const x0 = Math.round(w * (ca - cw / 2)), x1 = Math.round(w * (ca + cw / 2));
            g.fillStyle = 'rgba(255,255,255,0.05)';
            g.fillRect(x0, 0, Math.max(1, x1 - x0), h);
            g.fillStyle = css('--accent') || '#4c8dff';
            g.fillRect(x0, 0, 1, h);
            g.fillRect(x1 - 1, 0, 1, h);
            if (this.adjustable) {
                const s = 5 * dpr;
                g.fillStyle = 'rgba(255,255,255,0.7)';
                g.beginPath();
                g.moveTo(x0, 6 * dpr);
                g.lineTo(x0 - s, 6 * dpr + s);
                g.lineTo(x0, 6 * dpr + 2 * s);
                g.closePath();
                g.fill();
                g.beginPath();
                g.moveTo(x1, 6 * dpr);
                g.lineTo(x1 + s, 6 * dpr + s);
                g.lineTo(x1, 6 * dpr + 2 * s);
                g.closePath();
                g.fill();
            }
        }
        if (this.filled > 2 && this.rows >= 56 * dpr) {
            const now = performance.now();
            const oldest = (now - this.stamps[(this.head + this.filled - 1) % this.rows]) / 1000;
            const secPerPx = Math.max(1e-3, oldest / this.filled);
            const minPx = 40 * dpr;
            let ivl = 5;
            for (const c of [5, 10, 15, 30, 60, 120, 300, 600]) {
                ivl = c;
                if (c / secPerPx >= minPx)
                    break;
            }
            const label = (s) => s >= 120 ? `-${Math.round(s / 60)}m` : `-${s}s`;
            g.fillStyle = 'rgba(255,255,255,0.55)';
            g.font = `${Math.round(9 * dpr)}px ui-monospace, Menlo, Consolas, monospace`;
            g.textAlign = 'left';
            g.textBaseline = 'middle';
            let prevMark = -1;
            for (let y = 0; y < this.filled; y++) {
                const mark = Math.floor((now - this.stamps[(this.head + y) % this.rows]) / 1000 / ivl);
                if (prevMark >= 0 && mark !== prevMark && mark > 0) {
                    g.fillRect(0, y, 6 * dpr, 1);
                    g.fillText(label(mark * ivl), 8 * dpr, y);
                }
                prevMark = mark;
            }
        }
    }
    draw() {
        const c = this.sp;
        const cr = c.getBoundingClientRect();
        const cssW = cr.width || c.clientWidth || 300, cssH = cr.height || c.clientHeight || 90;
        if (c.width !== Math.round(cssW * this.dpr) || c.height !== Math.round(cssH * this.dpr)) {
            c.width = Math.round(cssW * this.dpr);
            c.height = Math.round(cssH * this.dpr);
        }
        const dpr = this.ui();
        const g = c.getContext('2d');
        const w = c.width, h = c.height;
        const accent = css('--accent') || '#4c8dff', hold = css('--hold') || '#ffaf00', muted = css('--muted') || '#8892a6';
        g.clearRect(0, 0, w, h);
        g.strokeStyle = 'rgba(255,255,255,0.07)';
        g.lineWidth = 1;
        g.fillStyle = muted;
        g.font = `${Math.round(9 * dpr)}px ui-monospace, Menlo, Consolas, monospace`;
        g.textAlign = 'right';
        g.textBaseline = 'top';
        const steps = Math.max(2, Math.round(this.rangeDb / 10));
        for (let k = 1; k < steps; k++) {
            const y = Math.round(h - (k / steps) * (h - 2)) + 0.5;
            g.beginPath();
            g.moveTo(0, y);
            g.lineTo(w, y);
            g.stroke();
            if (!Number.isNaN(this.floorDb))
                g.fillText(`${Math.round(this.floorDb + (k / steps) * this.rangeDb)}`, w - 3 * dpr, y + 1);
        }
        if (this.channel !== null && this.center) {
            const ca = (this.channelAt - this.start) * this.zoom, cw = this.channel * this.zoom;
            const x0 = w * (ca - cw / 2), x1 = w * (ca + cw / 2);
            g.fillStyle = 'rgba(255,255,255,0.06)';
            g.fillRect(x0, 0, Math.max(1, x1 - x0), h);
        }
        const n = this.cols;
        if (this.last.length >= n) {
            const step = w / n, xAt = (i) => (i + 0.5) * step;
            g.beginPath();
            g.moveTo(0, h);
            g.lineTo(0, h - this.last[0] * (h - 2));
            for (let i = 0; i < n; i++)
                g.lineTo(xAt(i), h - this.last[i] * (h - 2));
            g.lineTo(w, h - this.last[n - 1] * (h - 2));
            g.lineTo(w, h);
            g.closePath();
            const grad = g.createLinearGradient(0, 0, 0, h);
            grad.addColorStop(0, accent + 'aa');
            grad.addColorStop(1, accent + '10');
            g.fillStyle = grad;
            g.fill();
            g.beginPath();
            for (let i = 0; i < n; i++) {
                const x = xAt(i), y = h - this.last[i] * (h - 2);
                if (i === 0)
                    g.moveTo(x, y);
                else
                    g.lineTo(x, y);
            }
            g.save();
            g.shadowColor = accent;
            g.shadowBlur = 6 * dpr;
            g.strokeStyle = accent;
            g.lineWidth = Math.max(1, 1.25 * dpr);
            g.lineJoin = 'round';
            g.stroke();
            g.restore();
            g.beginPath();
            for (let i = 0; i < n; i++) {
                const x = xAt(i), y = h - this.peak[i] * (h - 2);
                if (i === 0)
                    g.moveTo(x, y);
                else
                    g.lineTo(x, y);
            }
            g.strokeStyle = hold + '99';
            g.lineWidth = 1;
            g.stroke();
            this.annotate(g, w, h, step);
        }
        const vline = (x, color, lw) => {
            const xr = Math.round(x) + 0.5;
            g.strokeStyle = 'rgba(0,0,0,0.6)';
            g.lineWidth = lw + 2.5 * dpr;
            g.beginPath();
            g.moveTo(xr, 0);
            g.lineTo(xr, h);
            g.stroke();
            g.strokeStyle = color;
            g.lineWidth = lw;
            g.beginPath();
            g.moveTo(xr, 0);
            g.lineTo(xr, h);
            g.stroke();
        };
        if (this.channel !== null && this.center) {
            const ca = (this.channelAt - this.start) * this.zoom, cw = this.channel * this.zoom;
            vline(w * (ca - cw / 2), accent, Math.max(1.25, 1.1 * dpr));
            vline(w * (ca + cw / 2), accent, Math.max(1.25, 1.1 * dpr));
        }
        const cx = this.toView(0.5);
        if (this.center && cx !== null)
            vline(w * cx, accent + 'aa', Math.max(1, 0.8 * dpr));
    }
    annotate(g, w, h, step) {
        if (this.signals) {
            this.drawLabels(g, w, h, this.signals.map(s => [this.toView(s.frac), s]).filter(([v]) => v !== null).map(([v, s]) => [v * w, h - s.val * (h - 2), s.text]));
            return;
        }
        if (!this.labelAt || Number.isNaN(this.floorDb))
            return;
        const v = this.peak, n = v.length;
        if (n < 8)
            return;
        const rad = Math.max(2, Math.round(n / 80)), sep = Math.max(3, Math.round(n / 30));
        const ps = this.prefix.length === n + 1 ? this.prefix : (this.prefix = new Float64Array(n + 1));
        for (let i = 0; i < n; i++)
            ps[i + 1] = ps[i] + v[i];
        const sm = this.smooth.length === n ? this.smooth : (this.smooth = new Float32Array(n));
        for (let i = 0; i < n; i++) {
            const a = Math.max(0, i - rad), b = Math.min(n, i + rad + 1);
            sm[i] = (ps[b] - ps[a]) / (b - a);
        }
        const min = (6 + 4) / this.rangeDb;
        const cands = [];
        for (let i = 1; i < n - 1; i++) {
            if (sm[i] < min || sm[i] < sm[i - 1] || sm[i] < sm[i + 1])
                continue;
            let best = true;
            for (let k = Math.max(0, i - sep); k < Math.min(n, i + sep); k++)
                if (sm[k] > sm[i]) {
                    best = false;
                    break;
                }
            if (!best)
                continue;
            let pk = 0;
            for (let k = Math.max(0, i - rad); k < Math.min(n, i + rad + 1); k++)
                if (v[k] > pk)
                    pk = v[k];
            cands.push([i, pk]);
        }
        cands.sort((a, b) => b[1] - a[1]);
        const dpr = this.ui();
        g.font = `${Math.round(9 * dpr)}px ui-monospace, Menlo, Consolas, monospace`;
        g.textBaseline = 'bottom';
        this.drawLabels(g, w, h, cands.slice(0, 8).map(([i, val]) => [(i + 0.5) * step, h - val * (h - 2), `${this.labelAt(this.start + ((i + 0.5) / n) / this.zoom, this.zoom)} ${Math.round(this.floorDb + val * this.rangeDb)}dB`]));
    }
    drawLabels(g, w, h, items) {
        const dpr = this.ui(), hold = css('--hold') || '#ffaf00';
        g.font = `${Math.round(9 * dpr)}px ui-monospace, Menlo, Consolas, monospace`;
        g.textBaseline = 'bottom';
        let row = 0, lastRight = -1e9;
        for (const [x, y, text] of items) {
            const right = x > w * 0.85;
            g.textAlign = right ? 'right' : 'left';
            const tw = g.measureText(text).width;
            row = x - lastRight < tw + 6 * dpr && x - lastRight > -tw ? (row + 1) % 3 : 0;
            const tx = right ? x - 3 * dpr : x + 3 * dpr, ty = Math.max(11 * dpr * (row + 1), y - 2 * dpr - row * 11 * dpr);
            g.fillStyle = 'rgba(0,0,0,0.55)';
            g.fillRect(right ? tx - tw - 2 * dpr : tx - 2 * dpr, ty - 10 * dpr, tw + 4 * dpr, 11 * dpr);
            g.fillStyle = hold;
            g.fillText(text, tx, ty);
            g.fillRect(x - dpr / 2, y, dpr, h - y);
            lastRight = right ? x : x + tw;
        }
    }
}
export function centredLabels(centerHz, spanHz) {
    return [0, 0.25, 0.5, 0.75, 1].map(f => [f, ((centerHz + (f - 0.5) * spanHz) / 1e6).toFixed(3)]);
}
export function rangeLabels(startHz, endHz, n = 5) {
    const out = [];
    for (let k = 0; k < n; k++) {
        const f = k / (n - 1);
        const hz = startHz + (endHz - startHz) * f;
        out.push([f, endHz - startHz >= 50e6 ? (hz / 1e6).toFixed(0) : (hz / 1e6).toFixed(2)]);
    }
    return out;
}
export function rowToSpec(row, cols) {
    const out = new Float32Array(cols);
    if (!row.length)
        return out;
    const sorted = Float32Array.from(row).sort();
    const floor = sorted[sorted.length >> 1] - 4;
    for (let c = 0; c < cols; c++) {
        const a = Math.floor(c * row.length / cols), b = Math.max(a + 1, Math.floor((c + 1) * row.length / cols));
        let peak = -999;
        for (let i = a; i < Math.min(b, row.length); i++)
            if (row[i] > peak)
                peak = row[i];
        out[c] = Math.min(1, Math.max(0, (peak - floor) / 30));
    }
    return out;
}
