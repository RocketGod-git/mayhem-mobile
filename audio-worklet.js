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
    // Gap concealment. A brief dry (a USB loss burst from the radio) used to drop straight back to a full 0.2 s
    // re-prime, and that 200 ms of silence is the pop people hear. Instead, hold and fade the last sample over a
    // short gap and keep playing; only a sustained dry (longer than maxGap) re-primes the cushion. gap counts the
    // samples concealed so far in the current dry run; last holds the last real output per channel, to fade from.
    this.maxGap = Math.round(48000 * 0.06);     // ~60 ms: past this a dry is a real dropout, so re-prime
    this.overDrop = Math.round(48000 * 0.05);   // ~50 ms: an overflow sheds a small slice, not a second
    this.gap = 0;
    this.last = new Float32Array(6);
    // Pop diagnostics, reported to the main thread so a click is attributable. dry counts underruns (a sustained
    // dry that forced a re-prime), conceal counts brief gaps smoothed over without a re-prime, over counts
    // overflow drops. since paces the report to about once a second; last* hold the previous reported values.
    this.dry = 0;
    this.conceal = 0;
    this.over = 0;
    this.since = 0;
    this.lastDry = 0;
    this.lastConceal = 0;
    this.lastOver = 0;
    this.port.onmessage = (e) => {
      if (e.data && e.data.port) { e.data.port.onmessage = (m) => this.take(m.data); }
      else this.take(e.data);
    };
  }
  // a Float32Array plays on both sides; { l, r } is stereo; { ch: [L, R, C, LFE, Ls, Rs] } is 5.1
  take(d) {
    // a hidden tab gets its audio in bursts: a deeper cushion there, back to the normal one when the tab is shown
    if (d && d.type === 'cushion') { this.setCushion(d.sec); return; }
    if (d instanceof Float32Array) this.push([d, d]);
    else if (d && d.l instanceof Float32Array && d.r instanceof Float32Array) this.push([d.l, d.r]);
    else if (d && Array.isArray(d.ch) && d.ch.length >= 2 && d.ch.every((x) => x instanceof Float32Array)) this.push(d.ch);
  }
  setCushion(sec) {
    const want = Math.round(48000 * sec);
    if (want > this.preroll && this.count < want) this.primed = false;   // one short wait now, instead of gaps all along
    else if (want < this.preroll && this.count > want * 1.25) { const drop = this.count - want; this.r = (this.r + drop) % this.cap; this.count -= drop; }
    this.preroll = want;
  }
  push(src) {
    const n = src[0].length, b = this.bufs, m = Math.min(src.length, 6);
    // Overflow: the buffer filled (the sink stalled). Shed a small slice from the oldest audio rather than half a
    // second, so a recovering stall is a tiny blip, not an audible jump. Repeated stalls shed repeated small slices.
    if (this.count + n > this.cap) { const drop = Math.min(this.count, Math.max(this.overDrop, this.count + n - this.cap)); this.r = (this.r + drop) % this.cap; this.count -= drop; this.over++; }
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
      if (this.count > 0) {
        const r = this.r;
        for (let c = 0; c < nc; c++) { const v = b[c][r]; out[c][i] = v; this.last[c] = v; }
        this.r = (r + 1) % this.cap; this.count--; this.gap = 0;
      } else if (this.primed) {
        // A dry run while primed: conceal it by holding and fading the last sample so there is no step to silence.
        if (this.gap === 0) this.conceal++;
        this.gap++;
        for (let c = 0; c < nc; c++) { out[c][i] = this.last[c]; this.last[c] *= 0.999; }
        // Past the gap limit it is a genuine dropout, not jitter: rebuild the cushion and count a real underrun.
        if (this.gap >= this.maxGap) { this.primed = false; this.gap = 0; this.dry++; }
      } else {
        for (let c = 0; c < nc; c++) out[c][i] = 0;
      }
    }
    // Report the pop counters about once a second, and only when one has moved, so the main thread can fold them
    // into its health line without a message every quantum.
    this.since += len;
    if (this.since >= sampleRate) {
      this.since = 0;
      if (this.dry !== this.lastDry || this.conceal !== this.lastConceal || this.over !== this.lastOver) {
        this.lastDry = this.dry; this.lastConceal = this.conceal; this.lastOver = this.over;
        this.port.postMessage({ type: 'audiodiag', underruns: this.dry, concealed: this.conceal, overflowDrops: this.over });
      }
    }
    return true;
  }
}
registerProcessor('mayhem-player', MayhemPlayer);
