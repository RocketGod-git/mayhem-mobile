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
  // a broadcast mast with the digital sidebands as two blocks either side of its carrier
  hd: { d: 'M50 30 L36 92 M50 30 L64 92 M41 70 H59 M8 22 H28 V44 H8 Z M72 22 H92 V44 H72 Z ' + arc(50, 30, 12, 200, 340, 14), circles: [[50, 30, 4]] },
  devices: { d: 'M22 88 L22 54 L50 32 L78 54 L78 88 Z M44 88 L44 70 L56 70 L56 88 ' + arc(50, 32, 12, -150, -30) + arc(50, 32, 22, -150, -30) },
  sat: { d: 'M40 40 L60 40 L60 60 L40 60 Z M10 44 L32 44 L32 56 L10 56 Z M68 44 L90 44 L90 56 L68 56 Z M32 50 L40 50 M60 50 L68 50 M50 60 L50 70 ' + arc(50, 90, 20, 200, 340) },
  adsb: { d: 'M50 6 L50 92 M6 52 L50 38 L94 52 M30 90 L50 78 L70 90' },
  // a small plane over a cloud: weather and traffic from 978 MHz
  uat: { d: 'M50 6 L50 46 M28 26 L50 18 L72 26 M41 46 L50 40 L59 46 M18 86 A12 12 0 0 1 26 64 A17 17 0 0 1 58 58 A14 14 0 0 1 82 72 A9 9 0 0 1 80 86 Z' },
  ais: { d: 'M8 60 L92 60 L78 84 L22 84 Z M50 60 L50 14 M50 20 L72 42 L50 42 ' + wave(8, 92, 94, 3, 12, 1.6) },
  aprs: { d: 'M50 12 L28 92 M50 12 L72 92 M38 55 L62 55 M33 74 L67 74 ' + arc(50, 14, 14, -150, -30) + arc(50, 14, 24, -150, -30) },
  pager: { d: 'M18 28 H82 Q88 28 88 34 V70 Q88 76 82 76 H18 Q12 76 12 70 V34 Q12 28 18 28 Z M22 42 L78 42 M22 54 L60 54 M70 66 L78 66' },
  ert: { d: arc(50, 55, 38, 150, 390) + 'M50 55 L74 30', dot: [50, 55, 5] },
  // three up-chirps, each sweeping the band and wrapping
  lora: { d: 'M10 80 L37 20 L37 80 L63 20 L63 80 L90 20' },
  // a balloon on its line, the sonde hanging under it
  sondes: { d: 'M50 8 A22 22 0 1 0 50.1 8 Z M50 52 L50 74 M40 74 H60 V92 H40 Z M44 81 H56' },
  // a lattice mast with its antennas, waves going out to both sides
  cell: { d: 'M50 30 L34 92 M50 30 L66 92 M41 66 H59 M37 80 H63 M45 48 H55 ' + arc(50, 26, 14, 140, 220, 16) + arc(50, 26, 26, 145, 215, 14) + arc(50, 26, 14, -40, 40, 16) + arc(50, 26, 26, -35, 35, 14), circles: [[50, 26, 4]] },
  btle: { d: 'M32 30 L68 68 L50 88 L50 12 L68 32 L32 70' },
  prowl: { d: arc(50, 64.8, 40.8, -158.8, -21.2, 11.47) + arc(50, 35.2, 40.8, 21.2, 158.8, 11.47) + 'M50 30 Q57 50 50 70 Q43 50 50 30 Z' },
  subghz: { d: 'M50 92 L50 42 M50 35 A7 7 0 1 0 50 49 A7 7 0 1 0 50 35 Z ' + 'M32.7 32 A20 20 0 0 1 67.3 32 M22.3 26 A32 32 0 0 1 77.7 26 M20 92 L80 92' },
  tpms: { d: 'M50 10 A40 40 0 1 0 50 90 A40 40 0 1 0 50 10 Z M50 30 A20 20 0 1 0 50 70 A20 20 0 1 0 50 30 Z M64 36 L78 22 M36 36 L22 22 M36 64 L22 78 M64 64 L78 78' },
  // a locomotive head-on: the cab, its windshield, two headlights, and the rails running away under it
  // a TV set on its stand with rabbit-ear antennas, a picture on the screen
  atsc: { d: 'M12 34 H88 Q92 34 92 38 V80 Q92 84 88 84 H12 Q8 84 8 80 V38 Q8 34 12 34 Z M18 42 H70 V76 H18 Z M50 34 L34 10 M50 34 L68 12 M30 84 L24 94 M70 84 L76 94 M22 70 L36 54 L46 64 L56 50 L66 62', circles: [[81, 48, 4], [81, 62, 4]] },
  trains: { d: 'M34 8 H66 Q76 8 76 18 V70 H24 V18 Q24 8 34 8 Z M32 20 H68 V38 H32 Z M38 70 L16 94 M62 70 L84 94 M30 82 H70', circles: [[36, 56, 5], [64, 56, 5]] },
  // Dispatch: a handheld radio, its speaker grille, and the call going out from it
  fleet: { d: 'M30 32 H54 Q60 32 60 38 V86 Q60 92 54 92 H30 Q24 92 24 86 V38 Q24 32 30 32 Z M32 32 V8 M32 50 H52 M32 62 H52 M32 74 H52 ' + arc(60, 52, 16, -40, 40, 10) + arc(60, 52, 30, -40, 40, 10) },
  vdl2: { d: 'M16 30 H84 Q90 30 90 36 V72 Q90 78 84 78 H16 Q10 78 10 72 V36 Q10 30 16 30 Z M22 66 L36 44 L50 60 L64 40 L78 56 M50 6 L50 20 M38 14 L62 14' },
  acars: { d: 'M16 30 H84 Q90 30 90 36 V72 Q90 78 84 78 H16 Q10 78 10 72 V36 Q10 30 16 30 Z M10 32 L50 56 L90 32 M50 6 L50 20 M38 14 L62 14' },
  // a spectrum peak over a baseline, a marker chevron over it: a bench analyzer's screen
  spectrum: { d: 'M8 86 H92 M8 78 L26 76 L34 72 L40 60 L46 28 L50 18 L54 28 L60 60 L66 72 L74 76 L92 78 M42 4 L50 11 L58 4' },
  // a pulse train over a baseline: what a captured burst looks like once it is sliced
  analyzer: { d: 'M8 70 H22 V32 H36 V70 H46 V32 H54 V70 H66 V32 H84 V70 H92 M8 86 H92' },
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
