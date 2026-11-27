/**
 * The waterfall's color maps (Settings, LOOK, WATERFALL), the same three as ui/Waterfall.kt WfPalette: Inferno, a
 * Rainbow in SDR++'s style, and Skin, built from the theme's own colors. Each is 256 RGBA entries. No DOM.
 */

export type WfPalette = 'INFERNO' | 'RAINBOW' | 'SKIN';
export const WF_PALETTES: { id: WfPalette; title: string }[] = [
  { id: 'INFERNO', title: "Inferno · the web app's" }, { id: 'RAINBOW', title: 'Rainbow · SDR++ style' }, { id: 'SKIN', title: "Skin · the theme's own colors" },
];

type Rgb = [number, number, number];
const hex = (h: string): Rgb => { const n = parseInt(h.replace('#', ''), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };

/** A table from color stops at 0..1, each channel straight between its two stops (Waterfalls.ramp). */
function ramp(stops: [number, Rgb][]): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256 * 4);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let k = 0; while (k < stops.length - 2 && t > stops[k + 1][0]) k++;
    const [t0, c0] = stops[k], [t1, c1] = stops[k + 1];
    const f = Math.min(1, Math.max(0, (t - t0) / (t1 - t0)));
    for (let c = 0; c < 3; c++) lut[i * 4 + c] = Math.round(c0[c] + (c1[c] - c0[c]) * f);
    lut[i * 4 + 3] = 255;
  }
  return lut;
}

/** HSV (hue in degrees, saturation and value 0..1) to RGB, as Android's Color.HSVToColor. */
export function hsv(h: number, s: number, v: number): Rgb {
  s = Math.min(1, Math.max(0, s)); v = Math.min(1, Math.max(0, v));
  if (s <= 0) { const g = Math.round(v * 255); return [g, g, g]; }
  const hx = h < 0 || h >= 360 ? 0 : h / 60, w = Math.floor(hx), f = hx - w;
  const p = v * (1 - s), q = v * (1 - s * f), t = v * (1 - s * (1 - f));
  const [r, g, b] = w === 0 ? [v, t, p] : w === 1 ? [q, v, p] : w === 2 ? [p, v, t] : w === 3 ? [p, q, v] : w === 4 ? [t, p, v] : [v, p, q];
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

/** The Rainbow: blue at the floor round to red, washing out to white at the very top (Waterfall.kt heat). */
export function heat(x: number): Rgb {
  const t = Math.min(1, Math.max(0, x));
  const sat = t > 0.85 ? Math.min(1, Math.max(0, (1 - t) / 0.15)) : 1;
  return hsv(240 * (1 - t), sat, 0.1 + t * 1.5);
}

/** The table for `p`; Skin reads the theme's paper and accents. */
export function wfLut(p: WfPalette, paper: string, accent: string, accent2: string): Uint8ClampedArray {
  if (p === 'RAINBOW') {
    const lut = new Uint8ClampedArray(256 * 4);
    for (let i = 0; i < 256; i++) { const [r, g, b] = heat(i / 255); lut.set([r, g, b, 255], i * 4); }
    return lut;
  }
  if (p === 'SKIN') {
    const pa = hex(paper), ac = hex(accent);
    const mid = pa.map((c, i) => c + (ac[i] - c) * 0.45) as Rgb;
    return ramp([[0, [0, 0, 0]], [0.30, mid], [0.60, ac], [0.85, hex(accent2)], [1, [255, 255, 255]]]);
  }
  return ramp([[0.00, [0, 0, 4]], [0.13, [31, 12, 72]], [0.25, [85, 15, 109]], [0.38, [136, 34, 106]], [0.50, [186, 54, 85]],
    [0.63, [227, 89, 51]], [0.75, [249, 140, 10]], [0.88, [249, 201, 50]], [1.00, [252, 255, 164]]]);
}

export const isWfPalette = (s: unknown): s is WfPalette => s === 'INFERNO' || s === 'RAINBOW' || s === 'SKIN';
