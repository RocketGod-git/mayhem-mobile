/**
 * The Satcom app's processor: one L-band carrier, either the Inmarsat-C NCS (EGC broadcasts) or an Aero P-channel
 * (ACARS to aircraft), through the BPSK receiver into its decoder. A snapshot goes to the screen once a second and
 * whenever a message comes in; Aero's ACARS lines go out as packet lines for Flight Msgs.
 *
 * Twins: core/sat/Satcom.kt and core/sat/Satcom.swift.
 */
import { type Emit, type IqProcessor } from '../core.js';
import { PskReceiver } from './psk.js';
import { StdcDecoder, STDC_SYMBOL_RATE, type EgcMessage, type StdcStats } from './stdc.js';
import { AeroDecoder, aesHex, type AeroStats } from './aero.js';

export type SatcomMode = 'egc' | 'aero600' | 'aero1200';

export interface SatcomSnap {
  mode: SatcomMode; hz: number; carrierHz: number; lock: number; lineDb: number;
  egc: StdcStats; aero: AeroStats | null; messages: EgcMessage[];
}

export class SatcomProcessor implements IqProcessor {
  centerHz = 0;
  channelHz = 0;
  private modeNow: SatcomMode = 'egc';
  private psk = new PskReceiver(STDC_SYMBOL_RATE, x => this.stdc.push(x));
  private readonly stdc = new StdcDecoder();
  private aero: AeroDecoder | null = null;
  private lastSnap = 0; private dirty = false; private wasLocked = false;

  constructor(private readonly emit: Emit) {
    this.stdc.onMessage = m => { this.dirty = true; if (m.parts === 1) this.emit({ type: 'log', line: `EGC: ${m.priorityName} · ${m.serviceName}${m.area ? ` · ${m.area}` : ''}` }); };
  }

  get mode(): SatcomMode { return this.modeNow; }
  set mode(m: SatcomMode) {
    if (m === this.modeNow) return;
    this.modeNow = m;
    if (m === 'egc') { this.aero = null; this.psk = new PskReceiver(STDC_SYMBOL_RATE, x => this.stdc.push(x)); }
    else {
      const a = new AeroDecoder(m === 'aero600' ? 600 : 1200);
      a.onAcars = (line, aes) => { this.emit({ type: 'packet', line }); this.emit({ type: 'log', line: `Aero: ACARS to AES ${aesHex(aes)}` }); this.dirty = true; };
      this.aero = a;
      this.psk = new PskReceiver(a.rate, x => a.push(x));
    }
    this.stdc.reset();
  }

  clear(): void { this.stdc.clear(); this.dirty = true; }
  reset(_rate: number): void { this.psk.reset(); this.stdc.reset(); this.aero?.reset(); }

  onIq(iq: Int8Array, rate: number): void {
    if (this.aero) this.aero.hz = this.channelHz;
    this.psk.onIq(iq, rate, this.channelHz - this.centerHz);
    const locked = this.psk.lock > 0.5;
    if (locked !== this.wasLocked) { this.wasLocked = locked; this.emit({ type: 'log', line: locked ? `Satcom: locked to the carrier ${fmtHz(this.psk.carrierHz)} from ${(this.channelHz / 1e6).toFixed(3)} MHz` : 'Satcom: carrier lost' }); }
    const now = Date.now();
    if (this.dirty || now - this.lastSnap > 1000) { this.dirty = false; this.lastSnap = now; this.emit({ type: 'satcom', snap: this.snap() }); }
  }

  snap(): SatcomSnap {
    const p = this.psk;
    return { mode: this.modeNow, hz: this.channelHz, carrierHz: Number.isFinite(p.carrierHz) ? p.carrierHz : NaN, lock: p.lock, lineDb: p.lineDb,
      egc: { ...this.stdc.stats }, aero: this.aero ? { ...this.aero.stats } : null, messages: this.stdc.messages() };
  }
}

const fmtHz = (hz: number) => (Number.isFinite(hz) ? `${hz >= 0 ? '+' : '−'}${Math.abs(hz / 1000).toFixed(2)} kHz` : '');
