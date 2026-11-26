class MayhemPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.cap = 48000 * 2;
    // L, R, then C, LFE, Ls, Rs for 5.1 (the extra four stay silent for mono and stereo)
    this.bufs = Array.from({ length: 6 }, () => new Float32Array(this.cap));
    this.r = 0; this.w = 0; this.count = 0;
    // Wait for a cushion before playing, and rebuild it if the buffer ever runs dry. A vocoder hands over a
    // whole frame's speech at once - P25 delivers 180 ms every 180 ms - so playing the instant a sample arrives
    // leaves no margin at all, and any jitter turns into a gap at the frame rate. Heard as chopping.
    this.preroll = 48000 * 0.2;
    this.primed = false;
    this.dry = 0;
    this.port.onmessage = (e) => {
      if (e.data && e.data.port) { e.data.port.onmessage = (m) => this.take(m.data); }
      else this.take(e.data);
    };
  }
  // a Float32Array plays on both sides; { l, r } is stereo; { ch: [L, R, C, LFE, Ls, Rs] } is 5.1
  take(d) {
    if (d instanceof Float32Array) this.push([d, d]);
    else if (d && d.l instanceof Float32Array && d.r instanceof Float32Array) this.push([d.l, d.r]);
    else if (d && Array.isArray(d.ch) && d.ch.length >= 2 && d.ch.every((x) => x instanceof Float32Array)) this.push(d.ch);
  }
  push(src) {
    const n = src[0].length, b = this.bufs, m = Math.min(src.length, 6);
    if (this.count + n > this.cap) { const drop = Math.min(this.count, this.cap / 2); this.r = (this.r + drop) % this.cap; this.count -= drop; }
    for (let i = 0; i < n; i++) {
      if (this.count >= this.cap) break;
      const w = this.w;
      for (let c = 0; c < m; c++) b[c][w] = src[c][i];
      for (let c = m; c < 6; c++) b[c][w] = 0;
      this.w = (w + 1) % this.cap; this.count++;
    }
  }
  process(_inputs, outputs) {
    const out = outputs[0], nc = Math.min(out.length, 6), len = out[0].length, b = this.bufs;
    if (!this.primed) {
      if (this.count < this.preroll) { for (const o of out) o.fill(0); return true; }
      this.primed = true;
    }
    for (let i = 0; i < len; i++) {
      if (this.count > 0) { const r = this.r; for (let c = 0; c < nc; c++) out[c][i] = b[c][r]; this.r = (r + 1) % this.cap; this.count--; }
      else { for (let c = 0; c < nc; c++) out[c][i] = 0; if (this.primed) { this.primed = false; this.dry++; } }
    }
    return true;
  }
}
registerProcessor('mayhem-player', MayhemPlayer);
