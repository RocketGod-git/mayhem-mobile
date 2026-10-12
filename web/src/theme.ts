/** Skins — the same set as the Android app (Mayhem firmware themes + Mayhem Mobile + Cyan). */
export interface Skin { id: string; title: string; paper: string; surface: string; panel: string; line: string; ink: string; muted: string; accent: string; accent2: string; }

export const SKINS: Skin[] = [
  { id: 'MAYHEM', title: 'Mayhem Mobile', paper: '#0a0d13', surface: '#121722', panel: '#1a2130', line: '#2a3348', ink: '#e8ecf4', muted: '#8d97ab', accent: '#4c8dff', accent2: '#ffaf00' },
  { id: 'CLASSIC', title: 'Mayhem Default', paper: '#000000', surface: '#141414', panel: '#1f1f1f', line: '#3f3f3f', ink: '#ffffff', muted: '#7f7f7f', accent: '#3b6cff', accent2: '#ffd200' },
  { id: 'YELLOW', title: 'Mayhem Yellow', paper: '#1f1f00', surface: '#2e2e00', panel: '#444400', line: '#666600', ink: '#ffffff', muted: '#999900', accent: '#cccc00', accent2: '#ffaf00' },
  { id: 'AQUA', title: 'Mayhem Aqua', paper: '#001f1f', surface: '#002e2e', panel: '#004444', line: '#006666', ink: '#ffffff', muted: '#009999', accent: '#00cccc', accent2: '#0090c8' },
  { id: 'GREEN', title: 'Mayhem Green', paper: '#002104', surface: '#003006', panel: '#004009', line: '#004f09', ink: '#ffffff', muted: '#00630c', accent: '#00cd1e', accent2: '#ffaf00' },
  { id: 'RED', title: 'Mayhem Red', paper: '#210400', surface: '#300600', panel: '#400900', line: '#4f0900', ink: '#ffffff', muted: '#8f1100', accent: '#cd1e00', accent2: '#ffaf00' },
  { id: 'DARK', title: 'Mayhem Dark', paper: '#000000', surface: '#0c0c0c', panel: '#161616', line: '#303030', ink: '#ffffff', muted: '#808080', accent: '#c8c8c8', accent2: '#606060' },
  { id: 'WARBLE', title: 'Cyan', paper: '#06090a', surface: '#0e1618', panel: '#16211f', line: '#2c3d3b', ink: '#e9f3f0', muted: '#94a9a4', accent: '#37eccb', accent2: '#ffd24a' },
];

let current: Skin = SKINS[0];
export function currentSkin(): Skin { return current; }

export function applySkin(s: Skin): void {
  current = s;
  const r = document.documentElement.style;
  r.setProperty('--paper', s.paper); r.setProperty('--surface', s.surface); r.setProperty('--panel', s.panel); r.setProperty('--line', s.line);
  r.setProperty('--ink', s.ink); r.setProperty('--muted', s.muted); r.setProperty('--accent', s.accent); r.setProperty('--accent2', s.accent2);
  // peak-hold color: the secondary accent unless it is too dark to read
  const lum = luminance(s.accent2);
  r.setProperty('--hold', lum < 0.15 ? s.ink : s.accent2);
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', s.paper);
  try { localStorage.setItem('skin', s.id); } catch { /* private mode */ }
}

export function loadSkin(): void {
  let id = 'MAYHEM';
  try { id = localStorage.getItem('skin') ?? id; } catch { /* ignore */ }
  applySkin(SKINS.find(s => s.id === id) ?? SKINS[0]);
}

function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const lin = (v: number) => { const d = v / 255; return d <= 0.03928 ? d / 12.92 : Math.pow((d + 0.055) / 1.055, 2.4); };
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}
