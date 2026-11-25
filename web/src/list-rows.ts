/**
 * A list whose rows are kept and updated in place (so a row's photo or scroll position is not rebuilt every frame).
 *
 * The empty state belongs to the list it sits over: it shows when there are no rows, and it goes the moment the
 * first row arrives. Anything in the list that is not a keyed row (the empty state, whatever its class, or a line of
 * text) is removed before the rows are laid out, so the list can never say it is empty while rows sit under it.
 */
export interface RowEl { dataset: Record<string, string | undefined>; remove(): void }
export interface ListEl<R extends RowEl> { readonly children: ArrayLike<unknown>; innerHTML: string; appendChild(r: R): unknown }

export function syncRows<T, R extends RowEl>(el: ListEl<R>, items: readonly T[], keyOf: (t: T) => string, attr: string,
  make: (key: string) => R, fill: (row: R, t: T) => void, emptyHtml: string): void {
  if (!items.length) { el.innerHTML = emptyHtml; return; }
  const rows = new Map<string, R>();
  for (const c of Array.from(el.children) as R[]) {
    const k = c.dataset[attr];
    if (k === undefined) c.remove(); else rows.set(k, c);
  }
  for (const t of items) {
    const k = keyOf(t);
    const row = rows.get(k) ?? make(k);
    rows.delete(k);
    fill(row, t);
    el.appendChild(row);   // moves an existing row into the current order
  }
  for (const r of rows.values()) r.remove();
}
