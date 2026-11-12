/**
 * Getting bursts in and out: raw I/Q (.cu8 unsigned, .cs8 signed, as rtl_433 and URH write them) and Flipper Zero
 * `.sub` RAW pulse files. Twin of core/analyzer/Files.kt and Files.swift.
 */

/** Unsigned bytes, offset 128 (rtl_sdr, rtl_433 `.cu8`, HackRF's `.u8` captures in this app). */
export function toCu8(iq: Int8Array): Uint8Array {
  const out = new Uint8Array(iq.length);
  for (let i = 0; i < iq.length; i++) out[i] = iq[i] + 128;
  return out;
}
/** Signed bytes (hackrf_transfer, rtl_433 `.cs8`). */
export const toCs8 = (iq: Int8Array): Uint8Array => new Uint8Array(iq.buffer.slice(iq.byteOffset, iq.byteOffset + iq.length));

/** A recording back to signed samples; `.cu8` / `.u8` / `.iq` are unsigned, everything else signed. */
export function fromIqFile(bytes: Uint8Array, name: string): Int8Array {
  const unsigned = /\.(cu8|u8|iq|raw)$/i.test(name);
  const out = new Int8Array(bytes.length & ~1);
  for (let i = 0; i < out.length; i++) out[i] = unsigned ? bytes[i] - 128 : (bytes[i] << 24) >> 24;
  return out;
}

/** The sample rate a file name gives (`_250k`, `2Msps`, `2M`, `_1000000Hz`), or null. */
export function rateFromName(name: string): number | null {
  const m = /(\d+(?:\.\d+)?)\s*(k|m)(?:sps|s\/s|hz)?(?![a-z])/i.exec(name.replace(/\d+(?:\.\d+)?\s*mhz/ig, ''));
  if (m) { const v = parseFloat(m[1]) * (m[2].toLowerCase() === 'k' ? 1e3 : 1e6); if (v >= 2e4 && v <= 2e7) return v; }
  const s = /(\d{6,8})\s*(?:sps|s\/s)/i.exec(name);
  return s ? +s[1] : null;
}
/** The center frequency a file name gives (`315MHz`, `433.92M`, `_433920000Hz`), or null. */
export function freqFromName(name: string): number | null {
  const m = /(\d{2,4}(?:\.\d+)?)\s*mhz/i.exec(name) ?? /(?:^|[_\-\s])(\d{3}(?:\.\d+)?)m(?![a-z])/i.exec(name);
  if (m) return Math.round(parseFloat(m[1]) * 1e6);
  const h = /(\d{8,10})\s*hz/i.exec(name) ?? /(?:^|[_\-\s])(\d{9})(?:[_\-.\s]|$)/.exec(name);
  return h ? +h[1] : null;
}

/** Flipper's presets: OOK at 650 kHz bandwidth, or 2-FSK at 2.38 / 47.6 kHz deviation. */
export function subPreset(fsk: boolean, shiftHz: number): string {
  if (!fsk) return 'FuriHalSubGhzPresetOok650Async';
  return shiftHz / 2 > 12_000 ? 'FuriHalSubGhzPreset2FSKDev476Async' : 'FuriHalSubGhzPreset2FSKDev238Async';
}

/** A Flipper `.sub` RAW file: signed microseconds, positive high, 512 to a line as the Flipper writes them. */
export function toSub(pulses: number[], freqHz: number, fsk: boolean, shiftHz: number): string {
  const lines = ['Filetype: Flipper SubGhz RAW File', 'Version: 1', `Frequency: ${Math.round(freqHz)}`, `Preset: ${subPreset(fsk, shiftHz)}`, 'Protocol: RAW'];
  for (let i = 0; i < pulses.length; i += 512) lines.push(`RAW_Data: ${pulses.slice(i, i + 512).join(' ')}`);
  return lines.join('\n') + '\n';
}

export interface SubFile { freqHz: number; preset: string; fsk: boolean; pulses: number[] }

/** Read a Flipper `.sub` RAW file. Null when it is not one (a decoded `.sub` holds a key, not pulses). */
export function parseSub(text: string): SubFile | null {
  let freqHz = 433_920_000, preset = '';
  const pulses: number[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const i = raw.indexOf(':');
    if (i < 0) continue;
    const k = raw.slice(0, i).trim(), v = raw.slice(i + 1).trim();
    if (k === 'Frequency') freqHz = +v || freqHz;
    else if (k === 'Preset') preset = v;
    else if (k === 'RAW_Data') for (const t of v.split(/\s+/)) { const x = parseInt(t, 10); if (x) pulses.push(x); }
  }
  if (!pulses.length) return null;
  return { freqHz, preset, fsk: /FSK/i.test(preset), pulses };
}

/**
 * Pulses back into samples, so a `.sub` goes through the same capture and views as anything off the air: a carrier
 * 100 kHz above center (clear of the DC the finder ignores) keyed on and off, or shifted ±20 kHz for FSK, over a
 * little noise, with a tenth of a second of noise before it for the finder to learn the floor from.
 */
export function synthesize(pulses: number[], fsk: boolean, rate = 1_000_000): Int8Array {
  let total = 0;
  for (const p of pulses) total += Math.min(Math.abs(p), 200_000);
  const lead = Math.round(rate * 0.1);
  const n = lead + Math.round(total * rate / 1e6) + lead;
  const out = new Int8Array(n * 2);
  let seed = 7;
  const noise = () => { seed = (seed * 1103515245 + 12345) >>> 0; return ((seed >>> 16) % 7) - 3; };
  let ph = 0, k = 0;
  const put = (amp: number, hz: number) => {
    ph += 2 * Math.PI * hz / rate;
    if (ph > Math.PI) ph -= 2 * Math.PI;
    out[2 * k] = Math.max(-128, Math.min(127, Math.round(amp * Math.cos(ph)) + noise()));
    out[2 * k + 1] = Math.max(-128, Math.min(127, Math.round(amp * Math.sin(ph)) + noise()));
    k++;
  };
  for (let i = 0; i < lead; i++) put(0, 0);
  for (const p of pulses) {
    const m = Math.round(Math.min(Math.abs(p), 200_000) * rate / 1e6), hi = p > 0;
    for (let i = 0; i < m && k < n; i++) put(fsk ? 60 : hi ? 60 : 0, fsk ? 100_000 + (hi ? 20_000 : -20_000) : 100_000);
  }
  while (k < n) put(0, 0);
  return out;
}

/** A name for an exported burst: where it was, the rate, and which one. */
export function exportName(freqHz: number, rate: number, id: number, ext: string): string {
  return `analyzer_${(freqHz / 1e6).toFixed(3)}MHz_${Math.round(rate / 1e3)}k_${id}.${ext}`;
}
