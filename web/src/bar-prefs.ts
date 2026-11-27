/**
 * The bottom bar's choices (Settings, BAR): every app in one order the user drags, the ones ticked, which are what
 * the bar shows, and where Mayhem opens (Home, or the last app used). Twin of core/NavBar.kt. No DOM: the caller
 * passes the stored text in and saves what comes out.
 */

export interface BarState { order: string[]; checked: Set<string>; opensLast: boolean; last: string | null }

/** The saved order with each app it lacks placed right after its nearest predecessor in the default (first if none). */
export function withNew(saved: string[], def: string[]): string[] {
  const out = saved.slice();
  def.forEach((a, i) => {
    if (out.includes(a)) return;
    const prev = def.slice(0, i).reverse().find(p => out.includes(p));
    if (prev !== undefined) out.splice(out.indexOf(prev) + 1, 0, a); else out.unshift(a);
  });
  return out;
}

/**
 * The bar from its stored JSON. Unknown apps drop out, an app new since the save goes in after the one it follows
 * by default and starts ticked (as on a fresh install), and a fresh install has every app ticked in the default order.
 */
export function loadBar(raw: string | null, def: string[]): BarState {
  let o: { order?: unknown; checked?: unknown; known?: unknown; opensLast?: unknown; last?: unknown } = {};
  try { if (raw) o = JSON.parse(raw) ?? {}; } catch { o = {}; }
  const list = (v: unknown) => Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && def.includes(x)))] : null;
  const saved = list(o.order);
  const order = saved && saved.length ? withNew(saved, def) : def.slice();
  const ch = list(o.checked);
  const known = Array.isArray(o.known) ? o.known.filter((x): x is string => typeof x === 'string') : null;
  const checked = new Set(ch ?? def);
  if (ch && known) for (const a of def) if (!known.includes(a)) checked.add(a);
  return { order, checked, opensLast: o.opensLast === true, last: typeof o.last === 'string' && def.includes(o.last) ? o.last : null };
}

/** The JSON the bar is stored as; `known` is every app this build has, so the next build can tell which are new. */
export const saveBar = (s: BarState, def: string[]) => JSON.stringify({ order: s.order, checked: s.order.filter(a => s.checked.has(a)), known: def, opensLast: s.opensLast, last: s.last });

/** The ticked apps, in order: what the bar shows. */
export const barList = (s: BarState) => s.order.filter(a => s.checked.has(a));

/** Tick or untick one app. */
export function toggleBar(s: BarState, app: string): void { if (s.checked.has(app)) s.checked.delete(app); else if (s.order.includes(app)) s.checked.add(app); }

/** Move the app at `from` to `to` (both indexes into the whole order). */
export function moveBar(s: BarState, from: number, to: number): void {
  if (from === to || from < 0 || to < 0 || from >= s.order.length || to >= s.order.length) return;
  const [a] = s.order.splice(from, 1);
  s.order.splice(to, 0, a);
}

/** Where Mayhem opens: the last app used when that is set and the app is still there, else Home (null). */
export const startApp = (s: BarState) => s.opensLast && s.last ? s.last : null;
