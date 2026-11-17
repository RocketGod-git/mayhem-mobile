/**
 * The map shared by the apps that plot what they hear: ADS-B aircraft, AIS vessels, APRS stations. Leaflet loads
 * from the CDN the first time a map is opened; OpenStreetMap tiles, inverted to match the dark skins.
 */
import { currentSkin } from './theme.js';

declare const L: any;

export type GeoKind = 'plane' | 'ship' | 'aton' | 'station' | 'object' | 'sat' | 'qso' | 'sonde' | 'landing' | 'burst' | 'airport' | 'tower';
/** [color] overrides the skin's accent for this marker (airports by flight category). */
export interface GeoItem { id: string; lat: number; lon: number; heading?: number; label: string; kind: GeoKind; color?: string }
/** A radar block: south-west corner, size in degrees, and its bins (cols across, rows from the north), 0 = clear. */
export interface RadarCell { lat: number; lon: number; dLat: number; dLon: number; cols: number; rows: number; bins: Uint8Array; colors?: string[] }
/** A hazard drawn on the map: an area or a line, colored, clickable (its id goes to onPick). */
export interface GeoShape { id: string; pts: [number, number][]; line: boolean; color: string; dashed?: boolean; label?: string; sel?: boolean }
export interface GeoOpts {
  home?: { lat: number; lon: number } | null;
  onPick: (id: string) => void;
  /** A tap on the map itself, not on a marker or a shape. */
  onMapTap?: (lat: number, lon: number) => void;
  onFollow?: (on: boolean) => void;
  log?: (line: string) => void;
  /** Fit the pins themselves, close in (meters a few hundred meters apart): one pin zooms right in on it. */
  fitPins?: boolean;
  /** Where the map opens before anything is plotted (your position, the last one known, or a stand-in). */
  start?: { lat: number; lon: number; zoom: number } | null;
}
/** Regional zoom: a couple of hundred kilometers across, where ships, stations and aircraft near you show up. */
export const REGION_ZOOM = 8;
const LAST_POS_KEY = 'mm.lastPos';
/** The last position this device reported, kept between visits (null when there never was one). */
export function lastKnownPos(): { lat: number; lon: number } | null {
  try {
    const v = JSON.parse(localStorage.getItem(LAST_POS_KEY) ?? 'null');
    return v && Number.isFinite(v.lat) && Number.isFinite(v.lon) ? { lat: v.lat, lon: v.lon } : null;
  } catch { return null; }
}
export function saveLastPos(p: { lat: number; lon: number }): void { try { localStorage.setItem(LAST_POS_KEY, JSON.stringify(p)); } catch { /* private window */ } }
/** Where a map opens: your position, else the last one known, else the middle of the US; always at regional zoom. */
export function mapStart(home: { lat: number; lon: number } | null): { lat: number; lon: number; zoom: number; standIn: boolean } {
  const p = home ?? lastKnownPos();
  return p ? { ...p, zoom: REGION_ZOOM, standIn: false } : { lat: 39.5, lon: -98.35, zoom: REGION_ZOOM - 3, standIn: true };
}

let leafletReady: Promise<void> | null = null;
function ensureLeaflet(log?: (s: string) => void): Promise<void> {
  if (leafletReady) return leafletReady;
  leafletReady = new Promise<void>((resolve, reject) => {
    const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css'; document.head.appendChild(css);
    const s = document.createElement('script'); s.src = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js';
    s.onload = () => resolve(); s.onerror = () => { leafletReady = null; log?.('map: could not load Leaflet (offline?)'); reject(new Error('leaflet')); };
    document.head.appendChild(s);
  });
  return leafletReady;
}
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const SHAPES: Record<GeoKind, (heading: number | undefined) => string> = {
  plane: () => '<path d="M0 -1.25 L0.15 -0.45 L1.15 0.18 L1.15 0.4 L0.15 0.1 L0.13 0.8 L0.55 1.12 L0.55 1.28 L0 1 L-0.55 1.28 L-0.55 1.12 L-0.13 0.8 L-0.15 0.1 L-1.15 0.4 L-1.15 0.18 L-0.15 -0.45 Z"/>',
  ship: h => h === undefined ? '<circle r="0.75"/>' : '<path d="M0 -1.25 L0.62 -0.35 L0.62 1.05 L-0.62 1.05 L-0.62 -0.35 Z"/>',
  aton: () => '<path d="M0 -1.1 L1.1 0 L0 1.1 L-1.1 0 Z"/>',
  station: () => '<circle r="0.8"/><circle r="0.3" fill="#0b1416"/>',
  object: () => '<rect x="-0.8" y="-0.8" width="1.6" height="1.6" rx="0.2"/>',
  sat: () => '<rect x="-0.35" y="-0.35" width="0.7" height="0.7"/><rect x="-1.3" y="-0.2" width="0.8" height="0.4"/><rect x="0.5" y="-0.2" width="0.8" height="0.4"/>',
  qso: () => '<circle r="0.6"/>',
  // a balloon on its line with the sonde under it
  sonde: () => '<circle cy="-0.55" r="0.62"/><rect x="-0.07" y="0.05" width="0.14" height="0.72" stroke="none"/><rect x="-0.3" y="0.75" width="0.6" height="0.5" rx="0.08"/>',
  // where it comes down: a target
  landing: () => '<path fill-rule="evenodd" d="M0 -1.1 A1.1 1.1 0 1 0 0.001 -1.1 Z M0 -0.78 A0.78 0.78 0 1 1 -0.001 -0.78 Z"/><circle r="0.32"/>',
  // where it burst: a star
  burst: () => '<path d="M0 -1.2 L0.3 -0.4 L1.15 -0.4 L0.45 0.12 L0.72 0.95 L0 0.45 L-0.72 0.95 L-0.45 0.12 L-1.15 -0.4 L-0.3 -0.4 Z"/>',
  // an airport reporting weather: a disc in its flight-category color with a dark ring
  airport: () => '<circle r="0.62"/>',
  // a FIS-B ground station: a mast with its waves
  tower: () => '<path d="M0 -0.5 L0.45 1.2 L0.2 1.2 L0 0.45 L-0.2 1.2 L-0.45 1.2 Z"/><circle cy="-0.62" r="0.22"/><path fill="none" stroke-width="0.14" d="M-0.62 -1.05 A0.75 0.75 0 0 0 -0.62 -0.2 M0.62 -1.05 A0.75 0.75 0 0 1 0.62 -0.2"/>',
};

export class GeoMap {
  follow = true;
  private map: any = null;
  private readonly markers = new Map<string, any>();
  private homeMarker: any = null;
  private items: GeoItem[] = []; private sel = '';
  private track: any = null; private trackPts: [number, number][] = []; private footprint: any = null; private lines: any[] = [];
  private paths: any[] = []; private pathDefs: { pts: [number, number][]; dashed?: boolean; faint?: boolean }[] = [];
  private radar: any = null; private radarCells: RadarCell[] = []; private radarColors: string[] = [];
  private shapes: any[] = []; private shapeDefs: GeoShape[] = []; private tapMark: any = null; private fitPts: [number, number][] = [];
  private readonly btn: HTMLButtonElement;
  private readonly emptyEl: HTMLElement;
  constructor(private readonly host: HTMLElement, private readonly opts: GeoOpts) {
    host.innerHTML = '<button class="follow" title="follow the traffic">⌖</button><div class="geo-empty" hidden></div>';
    this.btn = host.querySelector('.follow')!;
    this.emptyEl = host.querySelector('.geo-empty')!;
    this.btn.onclick = () => this.setFollow(!this.follow);
    this.btn.classList.toggle('on', this.follow);
    void ensureLeaflet(opts.log).then(() => { if (host.isConnected) this.build(); }).catch(() => undefined);
  }
  private build(): void {
    const home = this.opts.home, st = this.opts.start;
    this.map = L.map(this.host, { zoomControl: true, attributionControl: true }).setView(st ? [st.lat, st.lon] : home ? [home.lat, home.lon] : [39.5, -98.35], st ? st.zoom : home ? 9 : 4);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap contributors', className: 'dark-tiles' }).addTo(this.map);
    this.map.on('dragstart', () => { if (this.follow) this.setFollow(false); });
    this.map.on('click', (e: any) => this.opts.onMapTap?.(e.latlng.lat, e.latlng.lng));
    this.setHome(home ?? null);
    this.update(this.items, this.sel);
    if (this.trackPts.length) this.setTrack(this.trackPts);
    if (this.pathDefs.length) this.setPaths(this.pathDefs);
    if (this.radarCells.length) this.setRadar(this.radarCells, this.radarColors);
    if (this.shapeDefs.length) this.setShapes(this.shapeDefs);
    if (this.fitPts.length) this.fitTo(this.fitPts);
  }
  get ready(): boolean { return !!this.map; }
  setFollow(on: boolean): void { this.follow = on; this.btn.classList.toggle('on', on); this.opts.onFollow?.(on); if (on) this.fit(); }
  setHome(home: { lat: number; lon: number } | null): void {
    if (!this.map) return;
    if (this.homeMarker) { this.map.removeLayer(this.homeMarker); this.homeMarker = null; }
    if (home) this.homeMarker = L.marker([home.lat, home.lon], { icon: L.divIcon({ className: 'geo-wrap', iconSize: [20, 20], iconAnchor: [10, 10], html: '<div class="geo home"></div>' }), interactive: false }).addTo(this.map);
  }
  /** Replace the plotted set; markers keep their identity so the map does not blink. */
  update(items: GeoItem[], sel: string): void {
    this.items = items; this.sel = sel;
    if (!this.map) return;
    const live = new Set<string>();
    for (const it of items) {
      live.add(it.id);
      const icon = this.icon(it, it.id === sel);
      const m = this.markers.get(it.id);
      if (m) { m.setLatLng([it.lat, it.lon]); m.setIcon(icon); }
      else { const nm = L.marker([it.lat, it.lon], { icon }).addTo(this.map).on('click', () => this.opts.onPick(it.id)); this.markers.set(it.id, nm); }
    }
    for (const [id, m] of this.markers) if (!live.has(id)) { this.map.removeLayer(m); this.markers.delete(id); }
    if (this.follow) this.fit();
  }
  private icon(it: GeoItem, sel: boolean): any {
    const accent = currentSkin().accent;
    const rot = it.kind === 'plane' || it.kind === 'ship' ? it.heading ?? 0 : 0;
    return L.divIcon({ className: 'geo-wrap', iconSize: [60, 60], iconAnchor: [30, 30], html: `<div class="geo ${it.kind} ${sel ? 'sel' : ''}"><svg viewBox="-1.4 -1.4 2.8 2.8" style="transform:rotate(${rot}deg)" fill="${it.color ?? accent}" stroke="#0b1416" stroke-width="0.12" stroke-linejoin="round">${SHAPES[it.kind](it.heading)}</svg><span>${esc(it.label)}</span></div>` });
  }
  fit(): void {
    if (!this.map) return;
    const pts: [number, number][] = this.items.map(i => [i.lat, i.lon] as [number, number]).concat(this.trackPts);
    if (this.opts.home && (this.trackPts.length || this.lines.length)) pts.push([this.opts.home.lat, this.opts.home.lon]);
    if (!pts.length) return;
    // one point (or several on the same spot): glide there and zoom in as part of the glide
    const same = pts.every(p => Math.abs(p[0] - pts[0][0]) < 1e-6 && Math.abs(p[1] - pts[0][1]) < 1e-6);
    if (same) { this.map.flyTo(pts[0], this.opts.fitPins ? 15 : Math.max(this.map.getZoom(), 11)); return; }
    this.map.fitBounds(pts, { padding: this.opts.fitPins ? [70, 70] : [40, 40], maxZoom: this.opts.fitPins ? 17 : 11 });
  }
  /** Frames these points (an area and your position with it); remembered until the map is up. */
  fitTo(pts: [number, number][]): void {
    this.fitPts = pts;
    if (!this.map || !pts.length) return;
    this.map.invalidateSize(); this.map.fitBounds(pts, { padding: [28, 28], maxZoom: 15 });
  }
  center(lat: number, lon: number, minZoom = 9): void {
    if (!this.map) return;
    this.setFollow(false);
    this.map.invalidateSize(); this.map.setView([lat, lon], Math.max(this.map.getZoom(), minZoom));
  }
  invalidate(): void { this.map?.invalidateSize(); }
  /** The overlay shown over the map until the first contact ('' hides it): a title and a line under it. */
  setEmpty(title: string, sub = ''): void {
    this.emptyEl.hidden = !title;
    if (title) this.emptyEl.innerHTML = `<b>${esc(title)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}`;
  }
  /** Move the opening view (a position fix came in) while nothing is plotted yet. */
  recenter(lat: number, lon: number, zoom = REGION_ZOOM): void {
    if (!this.map || this.items.length || this.trackPts.length) return;
    this.map.setView([lat, lon], zoom);
  }
  /** A ground track (or any path): split where it crosses the antimeridian so Leaflet does not draw a line around the world. */
  setTrack(points: [number, number][]): void {
    this.trackPts = points;
    if (!this.map) return;
    if (this.track) { this.map.removeLayer(this.track); this.track = null; }
    if (!points.length) return;
    const segs: [number, number][][] = [[]];
    for (let i = 0; i < points.length; i++) { if (i && Math.abs(points[i][1] - points[i - 1][1]) > 180) segs.push([]); segs[segs.length - 1].push(points[i]); }
    this.track = L.polyline(segs, { color: currentSkin().accent, weight: 2, opacity: 0.8, dashArray: '6 5' }).addTo(this.map);
  }
  /** Coverage circle (a satellite's footprint), in km. */
  setFootprint(lat: number, lon: number, radiusKm: number): void {
    if (!this.map) return;
    if (!this.footprint) this.footprint = L.circle([lat, lon], { radius: radiusKm * 1000, color: currentSkin().accent, weight: 1, opacity: 0.7, fillOpacity: 0.08 }).addTo(this.map);
    else { this.footprint.setLatLng([lat, lon]); this.footprint.setRadius(radiusKm * 1000); }
  }
  /** Any number of paths (sonde flight tracks solid, predicted descents dashed), replaced as a set. */
  setPaths(defs: { pts: [number, number][]; dashed?: boolean; faint?: boolean }[]): void {
    this.pathDefs = defs;
    if (!this.map) return;
    for (const l of this.paths) this.map.removeLayer(l);
    const c = currentSkin().accent;
    this.paths = defs.filter(d => d.pts.length > 1).map(d => L.polyline(d.pts, { color: c, weight: d.dashed ? 2 : 3, opacity: d.faint ? 0.4 : 0.85, dashArray: d.dashed ? '6 6' : undefined, interactive: false }).addTo(this.map));
  }
  /**
   * Weather radar under the markers: every block projected onto the map tile by tile (a single stretched image would
   * drift on a Mercator map), [colors][level] for each intensity (0 is never drawn). Replaces the whole set.
   */
  setRadar(cells: RadarCell[], colors: string[]): void {
    this.radarCells = cells; this.radarColors = colors;
    if (!this.map) return;
    if (!this.radar) {
      const self = this;
      const Layer = L.GridLayer.extend({
        createTile(coords: any) {
          const t = document.createElement('canvas'), size = this.getTileSize();
          t.width = size.x; t.height = size.y;
          self.drawRadarTile(t, coords, size);
          return t;
        },
      });
      this.radar = new Layer({ opacity: 0.78, zIndex: 300, updateWhenZooming: false });
      this.radar.addTo(this.map);
    } else this.radar.redraw();
  }
  private drawRadarTile(canvas: HTMLCanvasElement, coords: any, size: any): void {
    const g = canvas.getContext('2d'); if (!g) return;
    const z = coords.z, ox = coords.x * size.x, oy = coords.y * size.y;
    const nw = this.map.unproject([ox, oy], z), se = this.map.unproject([ox + size.x, oy + size.y], z);
    for (const c of this.radarCells) {
      if (c.lat > nw.lat || c.lat + c.dLat < se.lat || c.lon > se.lng || c.lon + c.dLon < nw.lng) continue;
      const a = this.map.project([c.lat + c.dLat, c.lon], z), b = this.map.project([c.lat, c.lon + c.dLon], z);
      const x0 = a.x - ox, y0 = a.y - oy, w = (b.x - a.x) / c.cols, h = (b.y - a.y) / c.rows;
      // zoomed in far enough that a bin is several pixels: draw the block as a small image the canvas smooths, so
      // the weather reads as soft fields like a forecast map instead of hard squares
      if (w >= 4) {
        const img = this.cellImage(c);
        if (img) { g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high'; g.drawImage(img, x0, y0, b.x - a.x, b.y - a.y); }
        continue;
      }
      for (let r = 0; r < c.rows; r++) for (let k = 0; k < c.cols; k++) {
        const v = c.bins[r * c.cols + k], pal = c.colors ?? this.radarColors;
        if (!v || !pal[v]) continue;
        g.fillStyle = pal[v];
        // exact cell edges: overlapping cells drew a grid texture wherever the colors are see-through
        const xa = Math.round(x0 + k * w), xb = Math.round(x0 + (k + 1) * w), ya = Math.round(y0 + r * h), yb = Math.round(y0 + (r + 1) * h);
        g.fillRect(xa, ya, Math.max(1, xb - xa), Math.max(1, yb - ya));
      }
    }
  }
  private readonly cellImages = new WeakMap<RadarCell, HTMLCanvasElement | null>();
  /** One block as a cols x rows image in its colors (cached per block). */
  private cellImage(c: RadarCell): HTMLCanvasElement | null {
    if (this.cellImages.has(c)) return this.cellImages.get(c)!;
    const pal = c.colors ?? this.radarColors;
    const cv = document.createElement('canvas'); cv.width = c.cols; cv.height = c.rows;
    const g = cv.getContext('2d');
    if (g) for (let r = 0; r < c.rows; r++) for (let k = 0; k < c.cols; k++) { const v = c.bins[r * c.cols + k]; if (v && pal[v]) { g.fillStyle = pal[v]; g.fillRect(k, r, 1, 1); } }
    this.cellImages.set(c, g ? cv : null);
    return g ? cv : null;
  }
  /** Hazard areas and lines (G-AIRMETs, airspace), under the markers and over the radar; replaced as a set. */
  setShapes(defs: GeoShape[]): void {
    this.shapeDefs = defs;
    if (!this.map) return;
    for (const l of this.shapes) this.map.removeLayer(l);
    this.shapes = defs.filter(d => d.pts.length > (d.line ? 1 : 2)).map(d => {
      const o = { color: d.color, weight: d.sel ? 3.5 : d.line ? 2 : 1.5, opacity: d.sel ? 1 : 0.85, dashArray: d.dashed ? '6 5' : undefined, fillColor: d.color, fillOpacity: d.sel ? 0.28 : 0.12, bubblingMouseEvents: false };
      const l = (d.line ? L.polyline(d.pts, o) : L.polygon(d.pts, o)).addTo(this.map);
      if (d.label) l.bindTooltip(d.label, { sticky: true, direction: 'top', className: 'geo-tip' });
      l.on('click', () => this.opts.onPick(d.id));
      return l;
    });
  }
  /** A small ring where the map was tapped (null takes it away). */
  setTapMark(at: [number, number] | null): void {
    if (!this.map) return;
    if (!at) { if (this.tapMark) { this.map.removeLayer(this.tapMark); this.tapMark = null; } return; }
    if (!this.tapMark) this.tapMark = L.circleMarker(at, { radius: 7, color: currentSkin().accent, weight: 2, fillOpacity: 0, interactive: false }).addTo(this.map);
    else this.tapMark.setLatLng(at);
  }
  /** Straight lines between pairs of points (contacts from home). */
  setLines(lines: [[number, number], [number, number]][]): void {
    if (!this.map) return;
    for (const l of this.lines) this.map.removeLayer(l);
    this.lines = lines.map(l => L.polyline(l, { color: currentSkin().accent, weight: 1, opacity: 0.55 }).addTo(this.map));
  }
}
