/**
 * HackRF over WebUSB — a port of app/.../usb/HackRfOne.kt (itself a port of libhackrf). Vendor control transfers
 * on endpoint 0, bulk IN for signed-int8 IQ. Handles HackRF One / One r9 / Pro ("Praline") / Jawbreaker / rad1o,
 * including the Pro's post-RECEIVE cache-busting re-tune (see the comment at the bring-up).
 */

import type { Radio, RadioEvents, RadioLimits } from './radio.js';

export const HACKRF_FILTERS: USBDeviceFilter[] = [
  { vendorId: 0x1d50, productId: 0x6089 },   // HackRF One / One r9 / HackRF Pro
  { vendorId: 0x1d50, productId: 0x604b },   // Jawbreaker
  { vendorId: 0x1d50, productId: 0xcc15 },   // rad1o
];
const PID_MAYHEM_SERIAL = 0x6018;

export function isHackRf(d: USBDevice): boolean {
  return d.vendorId === 0x1d50 && HACKRF_FILTERS.some(f => f.productId === d.productId);
}
export function isMayhemSerial(d: USBDevice): boolean {
  return d.vendorId === 0x1d50 && d.productId === PID_MAYHEM_SERIAL;
}

const REQ = {
  SET_TRANSCEIVER_MODE: 1, SAMPLE_RATE_SET: 6, BASEBAND_FILTER_BW_SET: 7, BOARD_ID_READ: 14, VERSION_STRING_READ: 15,
  SET_FREQ: 16, AMP_ENABLE: 17, SET_LNA_GAIN: 19, SET_VGA_GAIN: 20, SET_TXVGA_GAIN: 21, SET_HW_SYNC_MODE: 29, BOARD_REV_READ: 45,
} as const;
const MODE_OFF = 0, MODE_RECEIVE = 1, MODE_TRANSMIT = 2;
const BB_FILTER_BW = [1750000, 2500000, 3500000, 5000000, 5500000, 6000000, 7000000, 8000000, 9000000, 10000000,
  12000000, 14000000, 15000000, 20000000, 24000000, 28000000];

export function boardName(id: number): string {
  return ['Jellybean', 'Jawbreaker', 'HackRF One', 'rad1o', 'HackRF One r9', 'HackRF Pro'][id] ?? 'HackRF?';
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

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

export class HackRf implements Radio {
  readonly kind = 'hackrf' as const;
  readonly limits = HACKRF_LIMITS;
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

  board = '';
  firmware = '';
  running = false;

  private epIn = 1; private epOut = 2;
  /** A queued transmission (see transmit()). The RX loop yields to it between buffers. */
  private txJob: { label: string; freqHz: number; rateHz: number; txVgaDb: number; amp: boolean; fill: (buf: Int8Array) => number; onDone: (err: string | null) => void } | null = null;
  private txCancel = false;
  txActive = false;
  private stopFlag = false;
  private appliedFreq = 0; private appliedRate = 0;
  private appliedLna = -1; private appliedVga = -1; private appliedAmp = -1;
  private dbgBuffers = 0;

  constructor(private dev: USBDevice, private ev: HackRfEvents) {}

  static async remembered(): Promise<USBDevice | undefined> {
    const ds = await navigator.usb.getDevices();
    return ds.find(isHackRf);
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
    this.appliedFreq = 0; this.appliedRate = 0; this.appliedLna = -1; this.appliedVga = -1; this.appliedAmp = -1;
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
    this.appliedFreq = 0; this.appliedRate = 0; this.appliedLna = -1; this.appliedVga = -1; this.appliedAmp = -1;
    await this.setTransceiverMode(MODE_OFF); await sleep(100);
    await this.setHwSync(false);
    await this.setSampleRate(this.targetRateHz); this.appliedRate = this.targetRateHz;
    await this.setBasebandFilter(bbFilterRoundDownLt(this.targetRateHz));
    await this.setFreq(this.targetFreqHz); this.appliedFreq = this.targetFreqHz;
    await this.applyGains();
    await this.setTransceiverMode(MODE_RECEIVE);
    // Pro fix: cache-bust the quarter-shift re-tune (see notes below), then re-assert gains.
    await sleep(40);
    await this.setFreq(this.targetFreqHz + 1_000_000);
    await this.setFreq(this.targetFreqHz);
    await this.applyGains();
    await sleep(60);
    this.ev.onLog(`HackRF: streaming IQ @ ${(this.targetFreqHz / 1e6).toFixed(3)} MHz, ${(this.targetRateHz / 1e6).toFixed(2)} Msps`);
    this.ev.onStatus(`${this.board} · ${(this.targetFreqHz / 1e6).toFixed(3)} MHz`);
  }

  /** Transmit one job on the bulk-OUT pipe (leaves the radio OFF; the run loop brings RX back). */
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

  // ---- streaming: keep a pool of bulk reads in flight, FIFO ---------------------------------------------------
  private async stream(): Promise<void> {
    const N = 8, SIZE = 65536;
    const inflight: Promise<USBInTransferResult>[] = [];
    for (let i = 0; i < N; i++) inflight.push(this.dev.transferIn(this.epIn, SIZE));
    let lastStatus = 0;
    while (!this.stopFlag && !this.txJob) {
      const res = await inflight.shift()!;
      if (!this.stopFlag && !this.txJob) inflight.push(this.dev.transferIn(this.epIn, SIZE));
      if (res.status !== 'ok' || !res.data) { this.ev.onLog(`HackRF: transfer ${res.status}`); if (res.status === 'stall') await this.dev.clearHalt('in', this.epIn); continue; }
      const dv = res.data;
      const buf = new Int8Array(dv.buffer, dv.byteOffset, dv.byteLength);
      if (this.dbgBuffers < 3) {
        this.dbgBuffers++;
        let nz = 0, mn = 127, mx = -128;
        for (let k = 0; k < buf.length; k++) { const v = buf[k]; if (v !== 0) nz++; if (v < mn) mn = v; if (v > mx) mx = v; }
        this.ev.onLog(`HackRF raw: n=${buf.length} nonZero=${nz}/${buf.length} min=${mn} max=${mx}`);
        if (nz === 0) {
          this.ev.onLog('HackRF: RX is all-zero samples — front-end delivering nothing. Check antenna, a data-capable OTG cable / powered hub, and that a PortaPack is in HackRF mode.');
          this.ev.onStatus('HackRF: no signal — check antenna / cable / PortaPack mode');
        } else if (nz * 50 < buf.length) {
          // A HackRF Pro at HackRF One gain settings sits well below one ADC count: not a fault, just too little gain.
          this.ev.onLog(`HackRF: RX level is under 1 LSB (${nz}/${buf.length} non-zero) — raise LNA / VGA (a HackRF Pro needs roughly 30 dB more VGA than a HackRF One).`);
        }
      }
      this.ev.onIq(buf);
      await this.applyPending();
      const now = performance.now();
      if (now - lastStatus > 1000) { lastStatus = now; this.ev.onStatus(`${this.board} · ${(this.appliedFreq / 1e6).toFixed(3)} MHz`); }
    }
    // drain
    await Promise.allSettled(inflight);
  }

  private async applyPending(): Promise<void> {
    const rateChanged = this.targetRateHz !== this.appliedRate;
    const freqChanged = this.targetFreqHz !== this.appliedFreq;
    const ampV = this.amp ? 1 : 0;
    const gainChanged = this.lnaDb !== this.appliedLna || this.vgaDb !== this.appliedVga || ampV !== this.appliedAmp;
    if (!rateChanged && !freqChanged && !gainChanged) return;
    if (rateChanged) {
      await this.setSampleRate(this.targetRateHz);
      await this.setBasebandFilter(bbFilterRoundDownLt(this.targetRateHz));
      this.appliedRate = this.targetRateHz;
    }
    if (freqChanged || rateChanged) {
      // cache-bust retune so the Pro's quarter shift is re-programmed
      await this.setFreq(this.targetFreqHz + 1_000_000);
      await this.setFreq(this.targetFreqHz);
      this.appliedFreq = this.targetFreqHz;
      await sleep(50);
      this.ev.onStatus(`${this.board} · ${(this.appliedFreq / 1e6).toFixed(3)} MHz`);
    }
    if (gainChanged) await this.applyGains();
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
  private async applyGains(): Promise<[number, number, number]> {
    const lna = Math.min(40, Math.max(0, this.lnaDb)) & ~7;
    const vga = Math.min(62, Math.max(0, this.vgaDb)) & ~1;
    const a = await this.ctrlOut(REQ.AMP_ENABLE, this.amp ? 1 : 0, 0, undefined, 'AMP');
    const l = (await this.ctrlIn(REQ.SET_LNA_GAIN, 0, lna, 1, 'LNA')) ? 1 : -1;
    const v = (await this.ctrlIn(REQ.SET_VGA_GAIN, 0, vga, 1, 'VGA')) ? 1 : -1;
    this.appliedLna = this.lnaDb; this.appliedVga = this.vgaDb; this.appliedAmp = this.amp ? 1 : 0;
    return [a, l, v];
  }
}

function bbFilterRoundDownLt(rate: number): number {
  let chosen = BB_FILTER_BW[0];
  for (const bw of BB_FILTER_BW) { if (bw < rate) chosen = bw; else break; }
  return chosen;
}
