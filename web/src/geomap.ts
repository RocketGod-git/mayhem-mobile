/**
 * The map shared by the apps that plot what they hear: ADS-B aircraft, AIS vessels, APRS stations. Leaflet loads
 * from the CDN the first time a map is opened; OpenStreetMap tiles, inverted to match the dark skins.
 */
import { currentSkin } from './theme.js';

declare const L: any;

export type GeoKind = 'plane' | 'ship' | 'aton' | 'station' | 'object' | 'sat' | 'qso';
export interface GeoItem { id: string; lat: number; lon: number; heading?: number; label: string; kind: GeoKind }
export interface GeoOpts {
  home?: { lat: number; lon: number } | null;
  onPick: (id: string) => void;
  onFollow?: (on: boolean) => void;
  log?: (line: string) => void;
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
};

export class GeoMap {
  follow = true;
  private map: any = null;
  private readonly markers = new Map<string, any>();
  private homeMarker: any = null;
  private items: GeoItem[] = []; private sel = '';
  private track: any = null; private trackPts: [number, number][] = []; private footprint: any = null; private lines: any[] = [];
  private readonly btn: HTMLButtonElement;
  constructor(private readonly host: HTMLElement, private readonly opts: GeoOpts) {
    host.innerHTML = '<button class="follow" title="follow the traffic">⌖</button>';
    this.btn = host.querySelector('.follow')!;
    this.btn.onclick = () => this.setFollow(!this.follow);
    this.btn.classList.toggle('on', this.follow);
    void ensureLeaflet(opts.log).then(() => { if (host.isConnected) this.build(); }).catch(() => undefined);
  }
  private build(): void {
    const home = this.opts.home;
    this.map = L.map(this.host, { zoomControl: true, attributionControl: true }).setView(home ? [home.lat, home.lon] : [39.5, -98.35], home ? 9 : 4);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap contributors', className: 'dark-tiles' }).addTo(this.map);
    this.map.on('dragstart', () => { if (this.follow) this.setFollow(false); });
    this.setHome(home ?? null);
    this.update(this.items, this.sel);
    if (this.trackPts.length) this.setTrack(this.trackPts);
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
    return L.divIcon({ className: 'geo-wrap', iconSize: [60, 60], iconAnchor: [30, 30], html: `<div class="geo ${it.kind} ${sel ? 'sel' : ''}"><svg viewBox="-1.4 -1.4 2.8 2.8" style="transform:rotate(${rot}deg)" fill="${accent}" stroke="#0b1416" stroke-width="0.12" stroke-linejoin="round">${SHAPES[it.kind](it.heading)}</svg><span>${esc(it.label)}</span></div>` });
  }
  fit(): void {
    if (!this.map) return;
    const pts: [number, number][] = this.items.map(i => [i.lat, i.lon] as [number, number]).concat(this.trackPts);
    if (this.opts.home && (this.trackPts.length || this.lines.length)) pts.push([this.opts.home.lat, this.opts.home.lon]);
    if (!pts.length) return;
    if (pts.length === 1) { this.map.panTo(pts[0]); return; }
    this.map.fitBounds(pts, { padding: [40, 40], maxZoom: 11 });
  }
  center(lat: number, lon: number, minZoom = 9): void {
    if (!this.map) return;
    this.setFollow(false);
    this.map.invalidateSize(); this.map.setView([lat, lon], Math.max(this.map.getZoom(), minZoom));
  }
  invalidate(): void { this.map?.invalidateSize(); }
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
  /** Straight lines between pairs of points (contacts from home). */
  setLines(lines: [[number, number], [number, number]][]): void {
    if (!this.map) return;
    for (const l of this.lines) this.map.removeLayer(l);
    this.lines = lines.map(l => L.polyline(l, { color: currentSkin().accent, weight: 1, opacity: 0.55 }).addTo(this.map));
  }
}
