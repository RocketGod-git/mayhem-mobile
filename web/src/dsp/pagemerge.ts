/**
 * Networks send a page more than once: a dispatcher repeats a call, a FLEX system re-sends to a pager that missed
 * it. When one copy came in partial (a word lost, or cut where the signal went), another copy of the same page fills
 * it in: a lost word in one is read from the other, and a copy that runs further supplies the rest.
 */
export interface PageText { text: string; errors: number }

const CUT = ' …';

/**
 * [a] and [b] as one page, or null when they are not copies of the same page (or both are already whole, which a
 * feed's fold handles). The caller checks they are for the same capcode and of the same kind. Characters agree
 * position by position; '?' (a lost word's place) gives way to a real character, and a copy cut short gives way to
 * one that runs on. More than a couple of disagreements, or too little in common to tell, and they are two pages.
 */
export function mergePages(a: PageText, b: PageText): PageText | null {
  if (a.errors === 0 && b.errors === 0) return null;
  if (!a.text.trim() || !b.text.trim()) return null;
  const aCut = a.text.endsWith(CUT), bCut = b.text.endsWith(CUT);
  const ta = aCut ? a.text.slice(0, -CUT.length) : a.text, tb = bCut ? b.text.slice(0, -CUT.length) : b.text;
  const n = Math.min(ta.length, tb.length);
  let agree = 0, differ = 0, out = '';
  for (let i = 0; i < n; i++) {
    const x = ta[i], y = tb[i];
    if (x === y) { out += x; if (x !== '?') agree++; }
    else if (x === '?') out += y;
    else if (y === '?') out += x;
    else { differ++; out += a.errors <= b.errors ? x : y; }
  }
  // the same page agrees almost everywhere it can be read in both
  if (agree < 6 || differ > Math.max(1, Math.floor(agree / 40))) return null;
  // past the shorter: whatever the longer copy has; a whole (uncut) copy's length is the page's length
  const longer = ta.length >= tb.length ? ta : tb;
  const shorterWhole = ta.length < tb.length ? !aCut && a.errors === 0 : !bCut && b.errors === 0;
  if (!shorterWhole) out += longer.slice(n);
  const cut = (ta.length > tb.length ? aCut : tb.length > ta.length ? bCut : aCut && bCut) && !shorterWhole;
  const lost = (out.match(/\?{3}/g) ?? []).length;
  const text = out.trimEnd() + (cut ? CUT : '');
  return { text, errors: lost === 0 && !cut ? 0 : Math.max(1, lost) };
}
