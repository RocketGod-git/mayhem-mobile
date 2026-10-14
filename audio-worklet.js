class MayhemPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.cap = 48000 * 2;
    this.buf = new Float32Array(this.cap);
    this.r = 0; this.w = 0; this.count = 0;
    // Wait for a cushion before playing, and rebuild it if the buffer ever runs dry. A vocoder hands over a
    // whole frame's speech at once - P25 delivers 180 ms every 180 ms - so playing the instant a sample arrives
    // leaves no margin at all, and any jitter turns into a gap at the frame rate. Heard as chopping.
    this.preroll = 48000 * 0.2;
    this.primed = false;
    this.dry = 0;
    this.port.onmessage = (e) => {
      if (e.data && e.data.port) { e.data.port.onmessage = (m) => this.push(m.data); }
      else if (e.data instanceof Float32Array) this.push(e.data);
    };
  }
  push(a) {
    if (this.count + a.length > this.cap) { const drop = Math.min(this.count, this.cap / 2); this.r = (this.r + drop) % this.cap; this.count -= drop; }
    for (let i = 0; i < a.length; i++) {
      if (this.count >= this.cap) break;
      this.buf[this.w] = a[i]; this.w = (this.w + 1) % this.cap; this.count++;
    }
  }
  process(_inputs, outputs) {
    const out = outputs[0][0];
    if (!this.primed) {
      if (this.count < this.preroll) { out.fill(0); return true; }
      this.primed = true;
    }
    for (let i = 0; i < out.length; i++) {
      if (this.count > 0) { out[i] = this.buf[this.r]; this.r = (this.r + 1) % this.cap; this.count--; }
      else { out[i] = 0; if (this.primed) { this.primed = false; this.dry++; } }
    }
    return true;
  }
}
registerProcessor('mayhem-player', MayhemPlayer);
