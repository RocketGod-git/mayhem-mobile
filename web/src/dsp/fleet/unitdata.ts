/**
 * What a unit sends besides its calls, as the fleet and the HAM identity show it: a position (P25 packet data and the
 * vendor GPS link controls, p25data.ts; NXDN data calls, nxdndata.ts), a status, a short message, a talker alias.
 * These positions are whole coordinates, not the low 16 bits a DMR unit report carries. No DOM.
 */
import type { Position } from '../hamid/gps.js';

/** A position a unit sent, with its heading (degrees, -1 unknown) when it said. */
export interface UnitPos extends Position { heading?: number }
export interface UnitData {
  proto: 'P25' | 'NXDN'; unit: number; kind: string; name: string; line: string; hex: string;
  position?: UnitPos; status?: number; message?: string; alias?: string; encrypted?: boolean;
}
export const posText = (p: UnitPos) => `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}${p.heading !== undefined && p.heading >= 0 ? ` · heading ${Math.round(p.heading)}` : ''}`;

/** The parts of a fleet unit this touches (fleet.ts keeps the rest). */
export interface FixUnit {
  posMs: number; posVerified: boolean; trail: [number, number, number][]; alias?: string; fix?: [number, number];
  reports: { lat: number | null; lon: number | null }[];
}
/**
 * A unit's data applied: a whole position becomes its fix, joins its trail (repeats folded) and marks the report just
 * made; an alias names it.
 */
export function applyUnitData(u: FixUnit, d: UnitData, now: number): void {
  if (d.alias) u.alias = d.alias;
  const p = d.position; if (!p) return;
  u.fix = [p.lat, p.lon]; u.posMs = now; u.posVerified = true;
  const l = u.trail[u.trail.length - 1];
  if (!l || l[0] !== p.lat || l[1] !== p.lon) { u.trail.push([p.lat, p.lon, now]); if (u.trail.length > 300) u.trail.shift(); }
  const r = u.reports[u.reports.length - 1]; if (r) { r.lat = p.lat; r.lon = p.lon; }
}
