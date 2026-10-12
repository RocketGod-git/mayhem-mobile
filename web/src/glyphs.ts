/** Line-art app glyphs (same drawings as the Android ui/Glyphs.kt), as inline SVG in a 100×100 box. */

function wave(x0: number, x1: number, y: number, amp: number, n: number, k: number): string {
  let d = '';
  for (let i = 0; i <= n; i++) {
    const x = x0 + (x1 - x0) * i / n;
    const env = Math.sin(Math.PI * i / n);
    const yy = y + amp * env * Math.sin(i * k);
    d += (i === 0 ? 'M' : 'L') + x.toFixed(1) + ' ' + yy.toFixed(1) + ' ';
  }
  return d;
}
function arc(cx: number, cy: number, r: number, a0: number, a1: number, step = 10): string {
  let d = '';
  for (let a = a0; a <= a1; a += step) {
    const x = cx + r * Math.cos(a * Math.PI / 180), y = cy + r * Math.sin(a * Math.PI / 180);
    d += (a === a0 ? 'M' : 'L') + x.toFixed(1) + ' ' + y.toFixed(1) + ' ';
  }
  return d;
}

const PATHS: Record<string, { d: string; circles?: [number, number, number][]; dot?: [number, number, number] }> = {
  ham: { d: 'M50 92 L50 14 M24 22 L76 22 M30 36 L70 36 M36 50 L64 50 M34 92 L66 92' },
  audio: { d: wave(5, 95, 50, 38, 40, 0.9) },
  devices: { d: 'M22 88 L22 54 L50 32 L78 54 L78 88 Z M44 88 L44 70 L56 70 L56 88 ' + arc(50, 32, 12, -150, -30) + arc(50, 32, 22, -150, -30) },
  sat: { d: 'M40 40 L60 40 L60 60 L40 60 Z M10 44 L32 44 L32 56 L10 56 Z M68 44 L90 44 L90 56 L68 56 Z M32 50 L40 50 M60 50 L68 50 M50 60 L50 70 ' + arc(50, 90, 20, 200, 340) },
  adsb: { d: 'M50 6 L50 92 M6 52 L50 38 L94 52 M30 90 L50 78 L70 90' },
  ais: { d: 'M8 60 L92 60 L78 84 L22 84 Z M50 60 L50 14 M50 20 L72 42 L50 42 ' + wave(8, 92, 94, 3, 12, 1.6) },
  aprs: { d: 'M50 12 L28 92 M50 12 L72 92 M38 55 L62 55 M33 74 L67 74 ' + arc(50, 14, 14, -150, -30) + arc(50, 14, 24, -150, -30) },
  pager: { d: 'M18 28 H82 Q88 28 88 34 V70 Q88 76 82 76 H18 Q12 76 12 70 V34 Q12 28 18 28 Z M22 42 L78 42 M22 54 L60 54 M70 66 L78 66' },
  ert: { d: arc(50, 55, 38, 150, 390) + 'M50 55 L74 30', dot: [50, 55, 5] },
  btle: { d: 'M32 30 L68 68 L50 88 L50 12 L68 32 L32 70' },
  subghz: { d: 'M50 92 L50 42 M50 35 A7 7 0 1 0 50 49 A7 7 0 1 0 50 35 Z ' + 'M32.7 32 A20 20 0 0 1 67.3 32 M22.3 26 A32 32 0 0 1 77.7 26 M20 92 L80 92' },
  tpms: { d: 'M50 10 A40 40 0 1 0 50 90 A40 40 0 1 0 50 10 Z M50 30 A20 20 0 1 0 50 70 A20 20 0 1 0 50 30 Z M64 36 L78 22 M36 36 L22 22 M36 64 L22 78 M64 64 L78 78' },
  acars: { d: 'M16 30 H84 Q90 30 90 36 V72 Q90 78 84 78 H16 Q10 78 10 72 V36 Q10 30 16 30 Z M10 32 L50 56 L90 32 M50 6 L50 20 M38 14 L62 14' },
  lookingglass: { d: 'M61 61 L90 90 ' + wave(28, 56, 42, -12, 10, 1.1), circles: [[42, 42, 26]] },
  search: { d: 'M50 8 L50 30 M50 70 L50 92 M8 50 L30 50 M70 50 L92 50', circles: [[50, 50, 30]], dot: [50, 50, 5] },
  capture: { d: '', circles: [[50, 50, 36]], dot: [50, 50, 20] },
  troll: { d: 'M20 76 H80 M24 76 L18 40 L34 58 L50 34 L66 58 L82 40 L76 76', circles: [[18, 40, 4], [50, 34, 4], [82, 40, 4]] },
  transmit: { d: 'M50 58 L50 92 M30 92 H70 ' + arc(50, 42, 16, -140, -40) + arc(50, 42, 28, -150, -30) + arc(50, 42, 40, -155, -25), dot: [50, 42, 4] },
  settings: { d: Array.from({ length: 8 }, (_, k) => { const a = k * 45 * Math.PI / 180; return `M${(50 + 28 * Math.cos(a)).toFixed(1)} ${(50 + 28 * Math.sin(a)).toFixed(1)} L${(50 + 40 * Math.cos(a)).toFixed(1)} ${(50 + 40 * Math.sin(a)).toFixed(1)}`; }).join(' '), circles: [[50, 50, 16], [50, 50, 28]] },
};

export function glyph(id: string, color: string, size = 36): string {
  const g = PATHS[id] ?? PATHS.capture;
  const circles = (g.circles ?? []).map(([cx, cy, r]) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="7"/>`).join('');
  const dot = g.dot ? `<circle cx="${g.dot[0]}" cy="${g.dot[1]}" r="${g.dot[2] + 2}" fill="${color}"/>` : '';
  return `<svg class="glyph" width="${size}" height="${size}" viewBox="0 0 100 100" aria-hidden="true"><path d="${g.d}" fill="none" stroke="${color}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>${circles}${dot}</svg>`;
}
