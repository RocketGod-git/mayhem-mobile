/** Transmit side (Mayhem siggen / morse / replay / OOK TX). A gate the user turns on in Settings; one job at a
 *  time on the HackRF's bulk-OUT pipe. Generators write signed-int8 IQ on a digital offset off the LO's DC leak. */
import type { HackRf } from './hackrf.js';
import * as Enc from './tx-encoders.js';
import * as Apps from './tx-apps.js';
import * as Weather from './dsp/tx-weather.js';

const RATE = 2_000_000, OFFSET = 100_000, AMP = 100;

const MORSE: Record<string, string> = {
  A: '.-', B: '-...', C: '-.-.', D: '-..', E: '.', F: '..-.', G: '--.', H: '....', I: '..', J: '.---', K: '-.-', L: '.-..', M: '--',
  N: '-.', O: '---', P: '.--.', Q: '--.-', R: '.-.', S: '...', T: '-', U: '..-', V: '...-', W: '.--', X: '-..-', Y: '-.--', Z: '--..',
  '0': '-----', '1': '.----', '2': '..---', '3': '...--', '4': '....-', '5': '.....', '6': '-....', '7': '--...', '8': '---..', '9': '----.',
  '.': '.-.-.-', ',': '--..--', '?': '..--..', '/': '-..-.', '=': '-...-', '-': '-....-', '@': '.--.-.', ':': '---...', '+': '.-.-.',
};

export type SigMode = 'cw' | 'fm' | 'am' | 'sweep';

export class Tx {
  enabled = true;   // default on; a session-scoped safety modal confirms the antenna before the first send
  active = false;
  gain = 20;
  amp = false;
  needsPrompt = true;
  onStatus: (s: string) => void = () => {};

  constructor(private radioGetter: () => HackRf | null) {
    try { const v = localStorage.getItem('mayhem.tx'); if (v !== null) this.enabled = v === '1'; } catch { /* ignore */ }
  }
  setEnabled(on: boolean): void { this.enabled = on; try { localStorage.setItem('mayhem.tx', on ? '1' : '0'); } catch { /* ignore */ } if (!on) this.stop(); }
  acknowledgeSafety(): void { this.needsPrompt = false; }

  private begin(label: string, freqHz: number, rateHz: number, offsetHz: number, fill: (buf: Int8Array) => number): boolean {
    if (!this.enabled) { this.onStatus('transmit is switched off in Settings'); return false; }
    if (this.needsPrompt) { this.onStatus('confirm the safety prompt first'); return false; }
    const radio = this.radioGetter();
    if (!radio || !radio.running) { this.onStatus('no HackRF'); return false; }
    if (this.active) { this.onStatus('already transmitting'); return false; }
    const ok = radio.transmit({
      label, freqHz: freqHz - offsetHz, rateHz, txVgaDb: this.gain, amp: this.amp, fill,
      onDone: (err) => { this.active = false; this.onStatus(err ? `TX failed: ${err}` : `done · ${label}`); },
    });
    if (!ok) { this.onStatus('radio busy'); return false; }
    this.active = true; this.onStatus(`TX · ${label}`);
    return true;
  }
  stop(): void { this.radioGetter()?.abortTx(); }

  /**
   * Push-to-talk FM voice from the microphone: 48 kHz mic audio (pre-emphasized, limited) frequency-modulates the
   * carrier at ±devHz, with an optional CTCSS tone at ±600 Hz. `mic` is a ring the AudioWorklet fills; the fill
   * callback reads it 40x oversampled (1.92 Msps).
   */
  fmVoice(freqHz: number, devHz: number, ctcssHz: number, mic: { read: () => number }): boolean {
    const R = 1_920_000, UP = 40;
    let ph = 0, tph = 0, hold = 0, sub = 0, pre = 0;
    const inc = 2 * Math.PI * OFFSET / R, tInc = 2 * Math.PI * ctcssHz / R;
    return this.begin(`FM voice ${(freqHz / 1e6).toFixed(4)} MHz`, freqHz, R, OFFSET, (buf) => {
      const n = buf.length >> 1;
      for (let i = 0; i < n; i++) {
        if (sub === 0) { const a = mic.read(); pre = 0.7 * pre + (a - 0.7 * pre); hold = Math.max(-1, Math.min(1, pre * 2.5)); }   // pre-emphasis + limiter
        if (++sub >= UP) sub = 0;
        const tone = ctcssHz > 0 ? 0.12 * Math.sin(tph) : 0;
        tph += tInc; if (tph > 2 * Math.PI) tph -= 2 * Math.PI;
        ph += inc + 2 * Math.PI * devHz * (hold * 0.85 + tone) / R; if (ph > 2 * Math.PI) ph -= 2 * Math.PI; else if (ph < 0) ph += 2 * Math.PI;
        buf[2 * i] = Math.round(AMP * Math.cos(ph)); buf[2 * i + 1] = Math.round(AMP * Math.sin(ph));
      }
      return n * 2;
    });
  }

  sigGen(freqHz: number, mode: SigMode, toneHz = 1000, seconds = 0): boolean {
    let ph = 0, mph = 0, sph = 0, remaining = seconds > 0 ? seconds * RATE : Infinity;
    const inc = 2 * Math.PI * OFFSET / RATE, mInc = 2 * Math.PI * toneHz / RATE, sInc = 2 * Math.PI * 0.5 / RATE;
    const names: Record<SigMode, string> = { cw: 'CW carrier', fm: 'FM tone', am: 'AM tone', sweep: 'sweep ±50 kHz' };
    return this.begin(`${names[mode]} ${(freqHz / 1e6).toFixed(4)} MHz`, freqHz, RATE, OFFSET, (buf) => {
      if (remaining <= 0) return 0;
      const n = Math.min(buf.length >> 1, remaining);
      for (let i = 0; i < n; i++) {
        let a = AMP, f = inc;
        if (mode === 'fm') { mph += mInc; f = inc + 2 * Math.PI * 5000 * Math.sin(mph) / RATE; }
        else if (mode === 'am') { mph += mInc; a = AMP * (0.5 + 0.5 * Math.sin(mph)); }
        else if (mode === 'sweep') { sph += sInc; f = inc + 2 * Math.PI * 50000 * Math.sin(sph) / RATE; }
        ph += f; if (ph > 2 * Math.PI) ph -= 2 * Math.PI;
        buf[2 * i] = Math.round(a * Math.cos(ph)); buf[2 * i + 1] = Math.round(a * Math.sin(ph));
      }
      remaining -= n;
      return n * 2;
    });
  }

  morse(text: string, wpm: number, freqHz: number, fmTone: boolean): boolean {
    const dit = Math.round(1.2 / Math.min(60, Math.max(5, wpm)) * RATE);
    const keying: [boolean, number][] = [];
    for (const word of text.toUpperCase().trim().split(/\s+/)) {
      for (let ci = 0; ci < word.length; ci++) {
        const code = MORSE[word[ci]]; if (!code) continue;
        for (let k = 0; k < code.length; k++) { keying.push([true, code[k] === '.' ? dit : dit * 3]); if (k < code.length - 1) keying.push([false, dit]); }
        if (ci < word.length - 1) keying.push([false, dit * 3]);
      }
      keying.push([false, dit * 7]);
    }
    if (!keying.length) { this.onStatus('nothing to send'); return false; }
    let idx = 0, left = keying[0][1]; const ramp = RATE / 250;
    let ph = 0, mph = 0, env = 0; const inc = 2 * Math.PI * OFFSET / RATE, mInc = 2 * Math.PI * 800 / RATE;
    return this.begin(`Morse "${text.slice(0, 24)}"`, freqHz, RATE, OFFSET, (buf) => {
      if (idx >= keying.length) return 0;
      const n = buf.length >> 1;
      for (let i = 0; i < n; i++) {
        if (left <= 0) { idx++; if (idx >= keying.length) { for (let k = i; k < n; k++) { buf[2 * k] = 0; buf[2 * k + 1] = 0; } return n * 2; } left = keying[idx][1]; }
        const on = keying[idx][0];
        env += on ? 1 / ramp : -1 / ramp; env = Math.min(1, Math.max(0, env));
        left--;
        let a: number, f = inc;
        if (fmTone) { a = AMP; mph += mInc; f = inc + (env > 0 ? 2 * Math.PI * 3000 * env * Math.sin(mph) / RATE : 0); }
        else a = AMP * env;
        ph += f; if (ph > 2 * Math.PI) ph -= 2 * Math.PI;
        buf[2 * i] = Math.round(a * Math.cos(ph)); buf[2 * i + 1] = Math.round(a * Math.sin(ph));
      }
      return n * 2;
    });
  }

  /** Replay a .c8 capture (Int8Array) captured at rateHz/freqHz (from its sidecar). */
  replay(name: string, iq: Int8Array, freqHz: number, rateHz: number): boolean {
    let pos = 0;
    return this.begin(`replay ${name}`, freqHz, rateHz, 0, (buf) => {
      if (pos >= iq.length) return 0;
      const n = Math.min(buf.length, iq.length - pos);
      buf.set(iq.subarray(pos, pos + n)); pos += n;
      return n;
    });
  }

  ookPrinceton(freqHz: number, code: number, bits: number, teUs: number, repeats: number): boolean {
    const te = Math.round(teUs * RATE / 1e6);
    const frame: [boolean, number][] = [];
    for (let r = 0; r < Math.min(50, Math.max(1, repeats)); r++) {
      for (let b = bits - 1; b >= 0; b--) { if ((code >>> b) & 1) { frame.push([true, te * 3]); frame.push([false, te]); } else { frame.push([true, te]); frame.push([false, te * 3]); } }
      frame.push([true, te]); frame.push([false, te * 31]);
    }
    let idx = 0, left = frame[0][1], ph = 0; const inc = 2 * Math.PI * OFFSET / RATE;
    return this.begin(`OOK ${code.toString(16).toUpperCase()} (${bits} bits)`, freqHz, RATE, OFFSET, (buf) => {
      if (idx >= frame.length) return 0;
      const n = buf.length >> 1;
      for (let i = 0; i < n; i++) {
        if (left <= 0) { idx++; if (idx >= frame.length) { for (let k = i; k < n; k++) { buf[2 * k] = 0; buf[2 * k + 1] = 0; } return n * 2; } left = frame[idx][1]; }
        left--;
        ph += inc; if (ph > 2 * Math.PI) ph -= 2 * Math.PI;
        const a = frame[idx][0] ? AMP : 0;
        buf[2 * i] = Math.round(a * Math.cos(ph)); buf[2 * i + 1] = Math.round(a * Math.sin(ph));
      }
      return n * 2;
    });
  }

  /** 2-level FSK from a bit list: true = +devHz, false = −devHz. */
  private fskBits(label: string, freqHz: number, bits: boolean[], baud: number, devHz: number): boolean {
    const spb = RATE / baud; const total = Math.floor(bits.length * spb);
    let i = 0, ph = 0; const inc = 2 * Math.PI * OFFSET / RATE;
    return this.begin(label, freqHz, RATE, OFFSET, (buf) => {
      if (i >= total) return 0;
      const n = buf.length >> 1;
      for (let k = 0; k < n; k++) {
        const bi = Math.min(bits.length - 1, Math.floor(i / spb));
        const dev = bits[bi] ? devHz : -devHz;
        ph += inc + 2 * Math.PI * dev / RATE; if (ph > 2 * Math.PI) ph -= 2 * Math.PI; if (ph < 0) ph += 2 * Math.PI;
        buf[2 * k] = Math.round(AMP * Math.cos(ph)); buf[2 * k + 1] = Math.round(AMP * Math.sin(ph));
        i++;
        if (i >= total) { for (let j = k + 1; j < n; j++) { buf[2 * j] = 0; buf[2 * j + 1] = 0; } return n * 2; }
      }
      return n * 2;
    });
  }

  /** NBFM of a per-symbol tone list (Hz; 0 = silence), optional second tone summed (DTMF / two-tone). */
  private fmTones(label: string, freqHz: number, tones: number[], samplesPerTone: number, devHz: number, pairs?: number[]): boolean {
    let idx = 0, left = samplesPerTone, ph = 0, aph = 0, aph2 = 0; const inc = 2 * Math.PI * OFFSET / RATE;
    return this.begin(label, freqHz, RATE, OFFSET, (buf) => {
      if (idx >= tones.length) return 0;
      const n = buf.length >> 1;
      for (let k = 0; k < n; k++) {
        if (left <= 0) { idx++; if (idx >= tones.length) { for (let j = k; j < n; j++) { buf[2 * j] = 0; buf[2 * j + 1] = 0; } return n * 2; } left = samplesPerTone; }
        left--;
        const t = tones[idx]; let audio = 0;
        if (t > 0) { aph += 2 * Math.PI * t / RATE; audio = Math.sin(aph); }
        if (pairs && idx < pairs.length && pairs[idx] > 0) { aph2 += 2 * Math.PI * pairs[idx] / RATE; audio = (audio + Math.sin(aph2)) * 0.5; }
        ph += inc + 2 * Math.PI * devHz * audio / RATE; if (ph > 2 * Math.PI) ph -= 2 * Math.PI; if (ph < 0) ph += 2 * Math.PI;
        buf[2 * k] = Math.round(AMP * Math.cos(ph)); buf[2 * k + 1] = Math.round(AMP * Math.sin(ph));
      }
      return n * 2;
    });
  }

  pocsagTx(address: number, func: number, message: string, type: Enc.PocsagType, baud: number, freqHz: number): boolean {
    const bits = Enc.pocsagBits(Enc.pocsag(address, func, message, type));
    return this.fskBits(`POCSAG ${address} ${baud}`, freqHz, bits, baud, 4500);
  }

  rtty(text: string, baud: number, shiftHz: number, freqHz: number): boolean {
    const syms = Enc.baudot(text);
    const bits: boolean[] = [];
    for (const sy of syms) { bits.push(false); for (let b = 0; b < 5; b++) bits.push(((sy >> b) & 1) === 1); bits.push(true, true, true); }
    return this.fskBits(`RTTY ${baud}/${shiftHz}`, freqHz, bits, baud, shiftHz / 2);
  }

  aprs(source: string, info: string, freqHz: number): boolean {
    const bits = Enc.ax25Bits(Enc.ax25Aprs(source, info), 48);
    const spb = RATE / 1200;
    const tones = bits.map(b => b ? 1200 : 2200);
    return this.fmTones(`APRS ${source}`, freqHz, tones, spb, 3500);
  }

  tones(mode: 'single' | 'two' | 'dtmf', dtmfStr: string, freqHz: number): boolean {
    if (mode === 'single') return this.fmTones('tone 1 kHz', freqHz, [1000], RATE * 3, 3000);
    if (mode === 'two') return this.fmTones('two-tone', freqHz, [1000], RATE * 3, 3000, [1600]);
    const row: number[] = [], col: number[] = [];
    for (const ch of dtmfStr) { const p = Enc.dtmf(ch); if (!p) continue; row.push(p[0], 0); col.push(p[1], 0); }
    if (!row.length) { this.onStatus('no DTMF digits'); return false; }
    return this.fmTones(`DTMF ${dtmfStr}`, freqHz, row, Math.floor(RATE / 8), 3000, col);
  }

  // ---- The rest of Mayhem's TX apps (see core/TxApps.kt) ----------------------------------------------------

  private ookPulses(label: string, freqHz: number, pulses: [boolean, number][]): boolean {
    if (!pulses.length) { this.onStatus('empty pulse list'); return false; }
    let idx = 0, left = pulses[0][1], ph = 0; const inc = 2 * Math.PI * OFFSET / RATE;
    return this.begin(label, freqHz, RATE, OFFSET, (buf) => {
      if (idx >= pulses.length) return 0;
      const n = buf.length >> 1;
      for (let i = 0; i < n; i++) {
        if (left <= 0) { idx++; if (idx >= pulses.length) { for (let k = i; k < n; k++) { buf[2 * k] = 0; buf[2 * k + 1] = 0; } return n * 2; } left = pulses[idx][1]; }
        left--;
        ph += inc; if (ph > 2 * Math.PI) ph -= 2 * Math.PI;
        const a = pulses[idx][0] ? AMP : 0;
        buf[2 * i] = Math.round(a * Math.cos(ph)); buf[2 * i + 1] = Math.round(a * Math.sin(ph));
      }
      return n * 2;
    });
  }

  /** MDC-1200 (Motorola PTT-ID), 1200 bps AFSK ±2.5 kHz FM. */
  mdc1200(op: number, arg: number, unitId: number, freqHz: number): boolean {
    const bytes = Apps.mdcPacket(op, arg, unitId);
    const bits: boolean[] = [];
    for (const b of bytes) for (let i = 7; i >= 0; i--) bits.push(((b >>> i) & 1) === 1);
    const spb = RATE / 1200;
    const tones = bits.map(b => b ? 1200 : 1800);
    return this.fmTones(`MDC-1200 ${unitId.toString(16).toUpperCase()} op=${op.toString(16).toUpperCase()}`, freqHz, tones, spb, 2500);
  }

  /** Motorola Quick-Call II two-tone paging: 1 s A, 3 s B, then a 26 s carrier tail. */
  quickCall2(freqA: number, freqB: number, freqHz: number): boolean {
    const list: number[] = [];
    for (let i = 0; i < 1; i++) list.push(freqA);
    for (let i = 0; i < 3; i++) list.push(freqB);
    for (let i = 0; i < 26; i++) list.push(0);
    return this.fmTones(`QC-II ${freqA}/${freqB}`, freqHz, list, RATE, 3000);
  }

  /** Random OOK on/off keying — authorized RF-lab work. */
  ookNoise(chipUs: number, seconds: number, freqHz: number): boolean {
    const chipSamples = Math.max(1, Math.floor(chipUs * RATE / 1_000_000));
    const chips = Math.floor(seconds * RATE / chipSamples);
    const bits = Apps.noiseBits(chips);
    return this.ookPulses(`noise ${seconds}s ${chipUs}µs`, freqHz, bits.map(b => [b, chipSamples] as [boolean, number]));
  }

  /** OOK brute-force Princeton codespace. */
  ookBrute(bits: number, from: number, to: number, teUs: number, freqHz: number): boolean {
    const te = Math.max(1, Math.floor(teUs * RATE / 1_000_000));
    const frame: [boolean, number][] = [];
    const end = Math.min(to, (1 << bits) - 1);
    for (let code = from; code <= end; code++) {
      for (let b = bits - 1; b >= 0; b--) { if ((code >>> b) & 1) { frame.push([true, te * 3]); frame.push([false, te]); } else { frame.push([true, te]); frame.push([false, te * 3]); } }
      frame.push([true, te]); frame.push([false, te * 31]);
    }
    return this.ookPulses(`OOK brute ${from}..${end}`, freqHz, frame);
  }

  /** SubGHz replay of a Flipper .sub file's RAW_Data pulses. */
  subghzReplay(subText: string, freqHz: number, repeats: number): boolean {
    const basic = Apps.parseSubFile(subText);
    if (!basic.length) { this.onStatus('no RAW_Data pulses'); return false; }
    const pulses: [boolean, number][] = [];
    for (let r = 0; r < Math.max(1, Math.min(20, repeats)); r++) for (const [level, us] of basic) pulses.push([level, Math.max(1, Math.floor(us * RATE / 1_000_000))]);
    return this.ookPulses(`SubGHz ${basic.length} × ${repeats}`, freqHz, pulses);
  }

  /**
   * De Bruijn "open sesame" gate opener: instead of sending each fixed OOK code in full, stream a de Bruijn
   * sequence in which every `bits`-bit code appears once as a sliding window, so a receiver keyed to any code in
   * that space matches as the window passes — the whole space in ~2^bits symbols rather than 2^bits × bits.
   */
  gateOpener(bits: number, teUs: number, freqHz: number): boolean {
    const seq = Apps.deBruijn(bits);
    const te = Math.max(1, Math.floor(teUs * RATE / 1_000_000));
    const pulses: [boolean, number][] = [];
    // Each code bit as a Princeton symbol: 1 = long-high/short-low, 0 = short-high/long-low.
    for (const b of seq) { if (b) { pulses.push([true, te * 3]); pulses.push([false, te]); } else { pulses.push([true, te]); pulses.push([false, te * 3]); } }
    return this.ookPulses(`gate opener ${bits}-bit · ${seq.length} sym`, freqHz, pulses);
  }

  /** Spoof an Acurite 592TXR weather sensor so a nearby display shows a phantom temperature/humidity. See tx-weather. */
  weatherSpoof(tempC: number, humidity: number | undefined, freqHz: number): boolean {
    const pulses = Weather.weatherPulses({ tempC, humidity }, RATE);
    return this.ookPulses(`weather ${tempC}°C ${humidity ?? '--'}%`, freqHz, pulses);
  }

  /** Tesla charge-port opener — a fixed OOK burst, same on 315 (US/JP) and 433.92 MHz (EU). See tx-apps.teslaPulses. */
  teslaChargePort(freqHz: number): boolean {
    return this.ookPulses(`Tesla charge port ${(freqHz / 1e6).toFixed(2)} MHz`, freqHz, Apps.teslaPulses(RATE));
  }

  /** FM jingle: sing a named tune (tx-apps.melody) as FM tones, wide enough to land on a broadcast FM receiver. */
  jingle(name: string, freqHz: number): boolean {
    const tones = Apps.melody(name);
    if (!tones.length) { this.onStatus('empty tune'); return false; }
    const slot = Math.floor(RATE * 0.11);   // ~110 ms a slot; a tune spells duration by repeating a note
    return this.fmTones(`jingle ${name}`, freqHz, tones, slot, 75_000);
  }

  /** KeeLoq HCS301 rolling-code TX. */
  keeloqTx(key: bigint, serial: number, button: number, counter: number, freqHz: number, repeats: number): boolean {
    const plain = ((button & 0xF) << 28) | (counter & 0x0FFFFFFF);
    const enc = Apps.keeloqEncrypt(plain, key);
    const bits = Apps.keeloqFrame(enc, serial, button, false, false);
    const te = Math.max(1, Math.floor(400 * RATE / 1_000_000));
    const pulses: [boolean, number][] = [];
    for (let r = 0; r < Math.max(1, Math.min(8, repeats)); r++) {
      for (let i = 0; i < 12; i++) { pulses.push([true, te]); pulses.push([false, te]); }
      pulses.push([true, te]); pulses.push([false, te * 10]);
      for (const b of bits) { if (b) { pulses.push([true, te * 2]); pulses.push([false, te]); } else { pulses.push([true, te]); pulses.push([false, te * 2]); } }
      pulses.push([false, te * 40]);
    }
    return this.ookPulses(`KeeLoq #${counter}`, freqHz, pulses);
  }

  /** Frequency hopper: dwell [dwellMs] on each of [freqs] in order, sending a CW carrier the whole time. */
  frequencyHopper(freqs: number[], dwellMs: number): boolean {
    if (!freqs.length) { this.onStatus('empty hop list'); return false; }
    let hi = 0, samplesLeft = Math.floor(dwellMs * RATE / 1000);
    return this.begin(`hop ×${freqs.length} · ${dwellMs}ms`, freqs[0], RATE, 0, (buf) => {
      if (hi >= freqs.length) return 0;
      const n = buf.length >> 1;
      const radio = this.radioGetter();
      for (let i = 0; i < n; i++) {
        if (samplesLeft <= 0) {
          hi++;
          if (hi >= freqs.length) { for (let k = i; k < n; k++) { buf[2 * k] = 0; buf[2 * k + 1] = 0; } return n * 2; }
          samplesLeft = Math.floor(dwellMs * RATE / 1000);
          if (radio) radio.targetFreqHz = freqs[hi];
        }
        samplesLeft--;
        buf[2 * i] = AMP; buf[2 * i + 1] = 0;
      }
      return n * 2;
    });
  }

  /** ADS-B DF17 short broadcast at 1090 MHz — illegal to rebroadcast in most places. */
  adsb(icao: number, meLo: number, meHi: number): boolean {
    const frame = Apps.adsbFrame(icao, meLo, meHi);
    const slots = Apps.adsbSymbols(frame);
    const rate = 8_000_000;
    const samplesPerHalfUs = rate / 2_000_000;
    const total = slots.length * samplesPerHalfUs;
    let i = 0;
    return this.begin(`ADS-B ${icao.toString(16).toUpperCase().padStart(6, '0')}`, 1_090_000_000, rate, 0, (buf) => {
      if (i >= total) return 0;
      const n = buf.length >> 1;
      for (let k = 0; k < n; k++) {
        const s = Math.min(slots.length - 1, Math.floor(i / samplesPerHalfUs));
        const a = slots[s] ? AMP : 0;
        buf[2 * k] = a; buf[2 * k + 1] = 0;
        i++;
        if (i >= total) { for (let j = k + 1; j < n; j++) { buf[2 * j] = 0; buf[2 * j + 1] = 0; } return n * 2; }
      }
      return n * 2;
    });
  }
}
