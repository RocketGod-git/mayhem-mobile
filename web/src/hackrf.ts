/**
 * HackRF over WebUSB — a port of app/.../usb/HackRfOne.kt (itself a port of libhackrf). Vendor control transfers
 * on endpoint 0, bulk IN for signed-int8 IQ. Handles HackRF One / One r9 / Pro ("Praline") / Jawbreaker / rad1o,
 * including the Pro's post-RECEIVE cache-busting re-tune (see the comment at the bring-up).
 */

import { DeliveryMeter } from './delivery.js';
import type { Radio, RadioCaps, RadioEvents, RadioLimits } from './radio.js';

export const HACKRF_FILTERS: USBDeviceFilter[] = [
  { vendorId: 0x1d50, productId: 0x6089 },   // HackRF One / One r9 / HackRF Pro
  { vendorId: 0x1d50, productId: 0x604b },   // Jawbreaker
  { vendorId: 0x1d50, productId: 0xcc15 },   // rad1o
];
const PID_MAYHEM_SERIAL = 0x6018;
/** A PortaPack running Mayhem shows up as a USB serial device until it is told to reboot into HackRF mode. */
export const MAYHEM_SERIAL_FILTER: USBDeviceFilter = { vendorId: 0x1d50, productId: PID_MAYHEM_SERIAL };

export function isHackRf(d: USBDevice): boolean {
  return d.vendorId === 0x1d50 && HACKRF_FILTERS.some(f => f.productId === d.productId);
}
export function isMayhemSerial(d: USBDevice): boolean {
  return d.vendorId === 0x1d50 && d.productId === PID_MAYHEM_SERIAL;
}

const REQ = {
  SET_TRANSCEIVER_MODE: 1, SAMPLE_RATE_SET: 6, BASEBAND_FILTER_BW_SET: 7, BOARD_ID_READ: 14, VERSION_STRING_READ: 15,
  SET_FREQ: 16, AMP_ENABLE: 17, SET_LNA_GAIN: 19, SET_VGA_GAIN: 20, SET_TXVGA_GAIN: 21, ANTENNA_ENABLE: 23, SET_HW_SYNC_MODE: 29, BOARD_REV_READ: 45,
} as const;
const MODE_OFF = 0, MODE_RECEIVE = 1, MODE_TRANSMIT = 2;
/** The MAX2837's baseband filter bandwidths (libhackrf max2837_ft). */
export const BB_FILTER_BW = [1750000, 2500000, 3500000, 5000000, 5500000, 6000000, 7000000, 8000000, 9000000, 10000000,
  12000000, 14000000, 15000000, 20000000, 24000000, 28000000];

export function boardName(id: number): string {
  return ['Jellybean', 'Jawbreaker', 'HackRF One', 'rad1o', 'HackRF One r9', 'HackRF Pro'][id] ?? 'HackRF?';
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** One bulk read, in bytes. */
const READ_SIZE = 65536;
/** Reads kept in flight, so a stalled page (a busy Mac audio thread, say) does not overflow the radio and drop
 *  samples - the loss bursts that are heard as audio pops. 16 at the wide audio rates (130 ms at 2 Msps), 32 from
 *  10 Msps up (52 ms at 20), 8 at the narrow rates where a stall is unlikely and latency matters more. */
export function readDepth(rate: number): number { return rate >= 10_000_000 ? 32 : rate >= 1_500_000 ? 16 : 8; }

/** Kept as a name of its own; structurally this is `RadioEvents`. */
export type HackRfEvents = RadioEvents;

/**
 * What a HackRF will do. One megahertz to six gigahertz, and it transmits, which is the whole reason to reach
 * for one over a dongle.
 *
 * The rate floor is deliberately below the two megasamples the datasheet quotes. This structure exists so an
 * RTL-SDR's much tighter limits can be enforced, and it must never alter what a HackRF already did: the HAM
 * screen has always opened at 1.92 Msps and that works, so a floor of two would have quietly rounded it up on
 * hardware that was perfectly happy. Anything the app asks a HackRF for has to fall inside this range, and
 * `test/rtlsdr.mjs` checks every rate in the app against it.
 */
export const HACKRF_LIMITS: RadioLimits = {
  minHz: 1_000_000,
  maxHz: 6_000_000_000,
  rates: [[1_000_000, 20_000_000]],
  canTransmit: true,
};

/** Everything a HackRF (One, r9, Pro, or a PortaPack in HackRF mode) can be told besides frequency. */
export const HACKRF_CAPS: RadioCaps = {
  stagedGain: true, tunerGain: false, amp: true, biasT: true, biasVolts: 3.3,
  tunerAgc: false, rtlAgc: false, ppm: false, directSampling: false, bbFilters: BB_FILTER_BW,
};

export class HackRf implements Radio {
  readonly kind = 'hackrf' as const;
  readonly limits = HACKRF_LIMITS;
  readonly caps = HACKRF_CAPS;
  /** What to call it on screen. Only known once bring-up has read the board id. */
  get label(): string { return this.board || 'HackRF'; }

  setGain(lnaDb: number, vgaDb: number, amp: boolean): void {
    this.lnaDb = lnaDb; this.vgaDb = vgaDb; this.amp = amp;
  }

  // Live control, applied between bulk transfers (retune never straddles a buffer).
  targetFreqHz = 92_300_000;
  targetRateHz = 2_000_000;
  lnaDb = 24;
  vgaDb = 24;
  amp = false;
  /** Antenna port power (libhackrf hackrf_set_antenna_enable): 3.3 V for an inline LNA. Off at every connect. */
  biasT = false;
  /** Baseband filter in hertz, or 0 to follow the sample rate (the largest bandwidth under it, as libhackrf does). */
  bbFilterHz = 0;

  board = '';
  firmware = '';
  running = false;

  private epIn = 1; private epOut = 2;
  /** A queued transmission (see transmit()). The RX loop yields to it between buffers. */
  private txJob: { label: string; freqHz: number; rateHz: number; txVgaDb: number; amp: boolean; fill: (buf: Int8Array) => number; onDone: (err: string | null) => void } | null = null;
  private txCancel = false;
  txActive = false;
  private stopFlag = false;
  private appliedFreq = 0;
  /** Exactly what was last written to the radio (null: nothing yet, or a transmission changed it). */
  private applied: RxSettings | null = null;
  private dbgBuffers = 0;

  constructor(private dev: USBDevice, private ev: HackRfEvents) {}

  static async remembered(): Promise<USBDevice | undefined> {
    const ds = await navigator.usb.getDevices();
    // A granted PortaPack still in Mayhem mode counts too, so start-up can switch it without a tap.
    return ds.find(isHackRf) ?? ds.find(isMayhemSerial);
  }

  static request(): Promise<USBDevice> {
    return navigator.usb.requestDevice({ filters: HACKRF_FILTERS });
  }

  async open(): Promise<void> {
    await this.dev.open();
    if (this.dev.configuration === null) await this.dev.selectConfiguration(1);
    await this.dev.claimInterface(0);
    const alt = this.dev.configuration?.interfaces[0]?.alternate;
    const ep = alt?.endpoints.find(e => e.type === 'bulk' && e.direction === 'in');
    if (!ep) throw new Error('no bulk-IN endpoint');
    this.epIn = ep.endpointNumber;
    const epo = alt?.endpoints.find(e => e.type === 'bulk' && e.direction === 'out');
    if (epo) this.epOut = epo.endpointNumber;
    this.ev.onLog(`HackRF: RX endpoint=0x${(0x80 | this.epIn).toString(16)} (expect 0x81)`);
  }

  /** Bring the radio up and stream until stop(). Resolves when streaming ends. */
  async run(): Promise<void> {
    if (this.running) return;
    this.running = true; this.stopFlag = false; this.dbgBuffers = 0;
    this.appliedFreq = 0; this.applied = null;
    try {
      this.ev.onLog('=== HackRF bring-up (WebUSB, libhackrf protocol) ===');
      this.ev.onStatus('HackRF · initializing…');
      const id = await this.boardId();
      this.board = boardName(id);
      this.firmware = await this.versionString();
      this.ev.onLog(`HackRF: board id = ${id} (${this.board})`);
      this.ev.onLog(`HackRF: fw='${this.firmware}' boardRev=${await this.boardRev()}`);

      // Clean slate: a HackRF left in RECEIVE makes a second RECEIVE a no-op that streams zeros; HW-sync left on
      // waits for a trigger forever. Force both off first (libhackrf never leaves the device in these states).
      while (!this.stopFlag) {
        await this.bringUpRx();
        await this.stream();
        const job = this.txJob;
        if (!job || this.stopFlag) break;
        this.txJob = null;
        await this.doTransmit(job);
      }
    } catch (e) {
      this.ev.onLog(`HackRF error: ${(e as Error).message}`);
      this.ev.onStatus(`HackRF stopped: ${(e as Error).message}`);
    } finally {
      try { await this.setTransceiverMode(MODE_OFF); } catch { /* device may be gone */ }
      // Never leave DC on the antenna port after we let go of the radio.
      if (this.biasT || (this.applied as RxSettings | null)?.bias) { try { await this.setAntennaPower(false); } catch { /* gone */ } }
      this.applied = null;
      try { await this.dev.releaseInterface(0); } catch { /* ignore */ }
      try { await this.dev.close(); } catch { /* ignore */ }
      this.running = false;
      this.ev.onLog('HackRF: RX loop stopped');
    }
  }

  stop(): void { this.stopFlag = true; }

  /** Queue a transmission; the RX loop picks it up between buffers. Returns false if the radio is down or busy. */
  transmit(job: { label: string; freqHz: number; rateHz: number; txVgaDb: number; amp: boolean; fill: (buf: Int8Array) => number; onDone: (err: string | null) => void }): boolean {
    if (!this.running || this.txJob || this.txActive) return false;
    this.txCancel = false; this.txJob = job; return true;
  }
  abortTx(): void { this.txCancel = true; }

  private async bringUpRx(): Promise<void> {
    this.appliedFreq = 0; this.applied = null;
    await this.setTransceiverMode(MODE_OFF); await sleep(100);
    await this.setHwSync(false);
    // every value from one snapshot: the page moves the controls while each transfer is awaited
    const want = this.snapshot();
    const g = gainStages(want);
    await this.setSampleRate(want.rateHz);
    await this.setBasebandFilter(bbFor(want));
    await this.setFreq(want.freqHz);
    await this.setGains(g);
    await this.setTransceiverMode(MODE_RECEIVE);
    // Pro: cache-busting re-tune after RECEIVE so the FPGA quarter shift is re-programmed
    await sleep(40);
    await this.setFreq(want.freqHz + 1_000_000);
    await this.setFreq(want.freqHz);
    await this.setGains(g);
    await this.setAntennaPower(want.bias);
    this.appliedFreq = want.freqHz;
    this.applied = want;   // a control moved during bring-up differs from this, so the first applyPending sends it
    await sleep(60);
    this.ev.onLog(`HackRF: streaming IQ @ ${(want.freqHz / 1e6).toFixed(3)} MHz, ${(want.rateHz / 1e6).toFixed(2)} Msps`);
    this.ev.onStatus(`${this.board} · ${(want.freqHz / 1e6).toFixed(3)} MHz`);
  }

  private async doTransmit(job: { label: string; freqHz: number; rateHz: number; txVgaDb: number; amp: boolean; fill: (buf: Int8Array) => number; onDone: (err: string | null) => void }): Promise<void> {
    this.txActive = true;
    let err: string | null = null;
    try {
      this.ev.onLog(`HackRF TX: ${job.label} @ ${(job.freqHz / 1e6).toFixed(4)} MHz, ${(job.rateHz / 1e6).toFixed(2)} Msps, txvga=${job.txVgaDb} amp=${job.amp}`);
      this.ev.onStatus(`TX · ${job.label}`);
      await this.setTransceiverMode(MODE_OFF); await sleep(50);
      await this.setSampleRate(job.rateHz); await this.setBasebandFilter(bbFilterRoundDownLt(job.rateHz));
      await this.setFreq(job.freqHz + 1_000_000); await this.setFreq(job.freqHz);
      await this.ctrlOut(REQ.AMP_ENABLE, job.amp ? 1 : 0, 0, undefined, 'AMP');
      await this.ctrlIn(REQ.SET_TXVGA_GAIN, 0, Math.min(47, Math.max(0, job.txVgaDb)), 1, 'TXVGA');
      await sleep(40);
      await this.setTransceiverMode(MODE_TRANSMIT);
      const buf = new Int8Array(32768);
      const N = 4; const inflight: Promise<USBOutTransferResult>[] = [];
      const fillOne = (): Int8Array | null => { const n = job.fill(buf); if (n <= 0) return null; return buf.slice(0, n); };
      for (let i = 0; i < N; i++) { const c = fillOne(); if (c) inflight.push(this.dev.transferOut(this.epOut, c)); }
      while (inflight.length && !this.stopFlag && !this.txCancel) {
        const r = await inflight.shift()!;
        if (r.status !== 'ok') { err = `bulk OUT ${r.status}`; break; }
        const c = fillOne(); if (c) inflight.push(this.dev.transferOut(this.epOut, c));
      }
      await Promise.allSettled(inflight);
      const zero = new Int8Array(32768);
      for (let i = 0; i < 2; i++) await this.dev.transferOut(this.epOut, zero).catch(() => undefined);
    } catch (e) { err = (e as Error).message; }
    finally {
      await this.setTransceiverMode(MODE_OFF).catch(() => undefined);
      await this.ctrlOut(REQ.AMP_ENABLE, 0, 0, undefined, 'AMP').catch(() => undefined);
      await sleep(60);
      this.txActive = false;
      job.onDone(err);
    }
  }

  /** Samples delivered against wall time (delivery.ts), restarted with every rate and retune. */
  readonly delivery = new DeliveryMeter();
  private restartDelivery(): void {
    const rate = this.applied?.rateHz ?? this.targetRateHz;
    this.delivery.restart(rate, performance.now(), readDepth(rate) * READ_SIZE / 2, READ_SIZE / 2);
  }

  // ---- streaming: keep a pool of bulk reads in flight, FIFO ---------------------------------------------------
  private async stream(): Promise<void> {
    const inflight: Promise<USBInTransferResult>[] = [];
    const topUp = (): void => {
      while (!this.stopFlag && !this.txJob && inflight.length < readDepth(this.targetRateHz)) inflight.push(this.dev.transferIn(this.epIn, READ_SIZE));
    };
    topUp();
    this.restartDelivery();
    let lastStatus = 0;
    while (!this.stopFlag && !this.txJob && inflight.length) {
      const res = await inflight.shift()!;
      topUp();
      if (res.status !== 'ok' || !res.data) { this.ev.onLog(`HackRF: transfer ${res.status}`); if (res.status === 'stall') await this.dev.clearHalt('in', this.epIn); continue; }
      const dv = res.data;
      const gap = this.delivery.push(dv.byteLength >> 1, performance.now());
      const buf = new Int8Array(dv.buffer, dv.byteOffset, dv.byteLength);
      if (this.dbgBuffers < 3) {
        this.dbgBuffers++;
        let nz = 0, mn = 127, mx = -128;
        for (let k = 0; k < buf.length; k++) { const v = buf[k]; if (v !== 0) nz++; if (v < mn) mn = v; if (v > mx) mx = v; }
        this.ev.onLog(`HackRF raw: n=${buf.length} nonZero=${nz}/${buf.length} min=${mn} max=${mx}`);
        if (nz === 0) {
          this.ev.onLog('HackRF: RX is all-zero samples — front-end delivering nothing. Check antenna, a data-capable OTG cable / powered hub, and that a PortaPack is in HackRF mode.');
          this.ev.onStatus('HackRF: no signal, check the antenna, the cable and PortaPack mode');
        } else if (nz * 50 < buf.length) {
          // A HackRF Pro at HackRF One gain settings sits well below one ADC count: not a fault, just too little gain.
          this.ev.onLog(`HackRF: RX level is under 1 LSB (${nz}/${buf.length} non-zero) — raise LNA / VGA (a HackRF Pro needs roughly 30 dB more VGA than a HackRF One).`);
        }
      }
      this.ev.onIq(buf);
      if (gap) this.ev.onGap?.(gap);
      if (await this.applyPending()) this.restartDelivery();
      const now = performance.now();
      if (now - lastStatus > 1000) { lastStatus = now; this.ev.onStatus(`${this.board} · ${(this.appliedFreq / 1e6).toFixed(3)} MHz`); }
    }
    // drain
    await Promise.allSettled(inflight);
  }

  /** The live controls at one instant. */
  snapshot(): RxSettings {
    return { rateHz: this.targetRateHz, freqHz: this.targetFreqHz, bbHz: this.bbFilterHz, lna: this.lnaDb, vga: this.vgaDb, amp: this.amp, bias: this.biasT };
  }

  /** Any change asked for since the last buffer. The controls are read once, written from that one reading and recorded as
   *  sent; a control moved while a transfer was awaited differs from the record and goes out on the next pass. */
  private async applyPending(): Promise<boolean> {
    const want = this.snapshot();
    const plan = retunePlan(want, this.applied);
    if (!plan.length) return false;
    for (const w of plan) {
      switch (w.kind) {
        case 'rate': await this.setSampleRate(w.hz); break;
        case 'bb': await this.setBasebandFilter(w.hz); break;
        case 'bias': await this.setAntennaPower(w.on); break;
        case 'retune':
          await this.setFreq(w.hz + 1_000_000);
          await this.setFreq(w.hz);
          this.appliedFreq = w.hz;
          await sleep(50);
          this.ev.onStatus(`${this.board} · ${(w.hz / 1e6).toFixed(3)} MHz`);
          break;
        case 'gains': await this.setGains(w); break;
      }
    }
    this.applied = want;
    // a new rate, and a retune's settling pause, are not lost samples
    return plan.some(w => w.kind === 'rate' || w.kind === 'retune');
  }

  // ---- vendor protocol ----------------------------------------------------------------------------------------
  private async ctrlOut(request: number, value: number, index: number, data?: BufferSource, tag = ''): Promise<number> {
    const r = await this.dev.controlTransferOut({ requestType: 'vendor', recipient: 'device', request, value, index }, data);
    const rc = r.status === 'ok' ? (r.bytesWritten ?? 0) : -1;
    if (tag) this.ev.onLog(`HackRF tx ${tag.padEnd(9)} OUT req=${request} wV=0x${value.toString(16).padStart(4, '0')} wI=0x${index.toString(16).padStart(4, '0')} rc=${rc}`);
    return rc;
  }
  private async ctrlIn(request: number, value: number, index: number, length: number, tag = ''): Promise<DataView | null> {
    const r = await this.dev.controlTransferIn({ requestType: 'vendor', recipient: 'device', request, value, index }, length);
    const ok = r.status === 'ok' && !!r.data;
    if (tag) this.ev.onLog(`HackRF tx ${tag.padEnd(9)} IN  req=${request} wV=0x${value.toString(16).padStart(4, '0')} wI=0x${index.toString(16).padStart(4, '0')} rc=${ok ? r.data!.byteLength : -1}`);
    return ok ? r.data! : null;
  }

  private async boardId(): Promise<number> { const d = await this.ctrlIn(REQ.BOARD_ID_READ, 0, 0, 1); return d ? d.getUint8(0) : -1; }
  private async boardRev(): Promise<number> { try { const d = await this.ctrlIn(REQ.BOARD_REV_READ, 0, 0, 1); return d ? d.getUint8(0) : -1; } catch { return -1; } }
  private async versionString(): Promise<string> {
    try {
      const d = await this.ctrlIn(REQ.VERSION_STRING_READ, 0, 0, 255);
      return d ? new TextDecoder('ascii').decode(new Uint8Array(d.buffer, d.byteOffset, d.byteLength)).trim() : '?';
    } catch { return '?'; }
  }
  private setTransceiverMode(m: number) { return this.ctrlOut(REQ.SET_TRANSCEIVER_MODE, m, 0, undefined, 'TRXMODE'); }
  private setHwSync(on: boolean) { return this.ctrlOut(REQ.SET_HW_SYNC_MODE, on ? 1 : 0, 0, undefined, 'HWSYNC'); }
  private setSampleRate(rate: number) {
    const d = new DataView(new ArrayBuffer(8)); d.setUint32(0, rate, true); d.setUint32(4, 1, true);
    return this.ctrlOut(REQ.SAMPLE_RATE_SET, 0, 0, d.buffer, 'SAMPLERATE');
  }
  private setBasebandFilter(bw: number) { return this.ctrlOut(REQ.BASEBAND_FILTER_BW_SET, bw & 0xffff, (bw >>> 16) & 0xffff, undefined, 'BBFILTER'); }
  private setFreq(hz: number) {
    const mhz = Math.floor(hz / 1_000_000), rem = hz - mhz * 1_000_000;
    const d = new DataView(new ArrayBuffer(8)); d.setUint32(0, mhz, true); d.setUint32(4, rem, true);
    return this.ctrlOut(REQ.SET_FREQ, 0, 0, d.buffer, 'SETFREQ');
  }
  private setAntennaPower(on: boolean) { return this.ctrlOut(REQ.ANTENNA_ENABLE, on ? 1 : 0, 0, undefined, 'ANTPOWER'); }
  private async setGains(g: { amp: boolean; lna: number; vga: number }): Promise<void> {
    await this.ctrlOut(REQ.AMP_ENABLE, g.amp ? 1 : 0, 0, undefined, 'AMP');
    await this.ctrlIn(REQ.SET_LNA_GAIN, 0, g.lna, 1, 'LNA');
    await this.ctrlIn(REQ.SET_VGA_GAIN, 0, g.vga, 1, 'VGA');
  }
}

/** Everything the radio is told in receive, read from the live controls at one instant. The page moves those controls while
 *  a control transfer is awaited, often several in a row (an app switch sets the rate twice and the gains three times), so a
 *  pass that re-read a control after writing it could record a value it never sent, and then never send it: the radio stayed
 *  at the old rate or gain while the app believed the new one. Every write comes from one snapshot, and the snapshot is recorded. */
export interface RxSettings {
  rateHz: number; freqHz: number;
  /** The baseband filter set by hand, 0 = follow the rate. */
  bbHz: number;
  lna: number; vga: number; amp: boolean; bias: boolean;
}
/** One step of a receive retune, in the order it is sent. 'retune' is the Pro's cache-busting pair (1 MHz off, then the target). */
export type RxWrite =
  | { kind: 'rate'; hz: number } | { kind: 'bb'; hz: number } | { kind: 'bias'; on: boolean }
  | { kind: 'retune'; hz: number } | { kind: 'gains'; amp: boolean; lna: number; vga: number };

/** The baseband filter for a setting: the one set by hand, else the largest under the rate (libhackrf's rule). */
export function bbFor(s: RxSettings): number { return s.bbHz || bbFilterRoundDownLt(s.rateHz); }
/** The stage values a setting asks for, on the steps the chips take (LNA 8 dB, VGA 2 dB). */
export function gainStages(s: RxSettings): { amp: boolean; lna: number; vga: number } {
  return { amp: s.amp, lna: Math.min(40, Math.max(0, s.lna)) & ~7, vga: Math.min(62, Math.max(0, s.vga)) & ~1 };
}
/** The writes that take the radio from what it was last told (have) to want, or every one of them when nothing was. */
export function retunePlan(want: RxSettings, have: RxSettings | null): RxWrite[] {
  const rate = !have || have.rateHz !== want.rateHz;
  const freq = !have || have.freqHz !== want.freqHz;
  const bb = !have || have.bbHz !== want.bbHz;
  const bias = !have || have.bias !== want.bias;
  const gain = !have || have.lna !== want.lna || have.vga !== want.vga || have.amp !== want.amp;
  const w: RxWrite[] = [];
  if (rate) w.push({ kind: 'rate', hz: want.rateHz });
  if (rate || bb) w.push({ kind: 'bb', hz: bbFor(want) });
  if (bias) w.push({ kind: 'bias', on: want.bias });
  // any freq or rate change gets the cache-bust retune so the Pro's quarter shift is re-programmed
  if (freq || rate) w.push({ kind: 'retune', hz: want.freqHz });
  if (gain) w.push({ kind: 'gains', ...gainStages(want) });
  return w;
}

function bbFilterRoundDownLt(rate: number): number {
  let chosen = BB_FILTER_BW[0];
  for (const bw of BB_FILTER_BW) { if (bw < rate) chosen = bw; else break; }
  return chosen;
}
