/**
 * The app's keypad: the one way a frequency (or any value with a unit) is typed, on every screen and in every app,
 * the same as the Android app's. Digits count 1 2 3 from the top, then 0, '.', and C (± for a signed value), ⌫, and
 * a column of unit keys: a unit key enters the number in that unit. A keyboard works too: digits, '.', '-',
 * Backspace, Esc, Enter (the value's own unit, or Hz for a long frequency typed out in full), and a unit's first
 * letter (g, m, k, h; s, u for times).
 */
export interface KeypadOpts {
  /** The title over the display: FREQUENCY, CENTER, FROM... */
  label: string;
  /** The unit keys, top down, with what each multiplies by. */
  units: [string, number][];
  /** The unit Enter uses, as an index into [units]; [auto] overrides it. */
  enterUnit?: number;
  /** Picks Enter's multiplier from the number typed (a frequency typed out in Hz needs no unit). */
  auto?: (n: number) => number;
  /** ± instead of C: the value can be negative. */
  signed?: boolean;
  /** What is already typed (a digit typed on a keyboard opens the keypad with it). */
  seed?: string;
  /** Shown dim while nothing is typed: the value now. */
  hint?: string;
  onEnter: (value: number) => void;
}

/** Hz, kHz, MHz, GHz: every frequency the app asks for. */
export const FREQ_UNITS: [string, number][] = [['GHz', 1e9], ['MHz', 1e6], ['kHz', 1e3], ['Hz', 1]];
/** Enter on a frequency: MHz, unless it was typed out in Hz (100000 and up). */
export const freqAuto = (n: number) => (n >= 1e5 ? 1 : 1e6);

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
let wrap: HTMLElement | null = null;
let cur: (KeypadOpts & { text: string }) | null = null;

export const keypadOpen = () => cur !== null;

export function openKeypad(o: KeypadOpts): void {
  cur = { ...o, text: (o.seed ?? '').replace(',', '.') };
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.className = 'sp-padwrap kp-wrap';
    document.body.appendChild(wrap);
    wrap.onclick = (e) => {
      if (!cur) return;
      if (e.target === wrap) { closeKeypad(); return; }
      const b = (e.target as HTMLElement).closest('button') as HTMLElement | null; if (!b) return;
      const k = b.dataset.p!;
      if (k === 'esc') closeKeypad();
      else if (k === 'u') enter(Number(b.dataset.m));
      else key(k);
    };
    // ahead of every other key handler, so a digit typed here never reaches the screen underneath
    window.addEventListener('keydown', (e) => { if (cur && hardKey(e)) { e.preventDefault(); e.stopImmediatePropagation(); } }, true);
  }
  draw();
}

export function closeKeypad(): void {
  cur = null;
  if (wrap) { wrap.hidden = true; wrap.innerHTML = ''; }
}

function draw(): void {
  const p = cur; if (!p || !wrap) return;
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '.', p.signed ? '±' : 'C'];
  wrap.hidden = false;
  wrap.innerHTML = `<div class="sp-pad" role="dialog" aria-label="${esc(p.label)}">
    <div class="sp-padh"><span>${esc(p.label)}</span><button data-p="esc" aria-label="Close">✕</button></div>
    <div class="sp-padv">${shown()}</div>
    <div class="sp-padg"><div class="sp-padk">${keys.map(k => `<button data-p="${k}">${k}</button>`).join('')}</div>
    <div class="sp-padu">${p.units.map(([l, m]) => `<button data-p="u" data-m="${m}">${esc(l)}</button>`).join('')}<button data-p="bs" aria-label="Backspace">⌫</button></div></div></div>`;
}
const shown = () => (cur!.text ? `${esc(cur!.text)}<i></i>` : `<i></i><span class="kp-hint">${esc(cur!.hint ?? '')}</span>`);

function key(k: string): void {
  const p = cur; if (!p) return;
  if (k === 'bs') p.text = p.text.slice(0, -1);
  else if (k === 'C') p.text = '';
  else if (k === '±') p.text = p.text.startsWith('-') ? p.text.slice(1) : '-' + p.text;
  else if (k === '.' ? !p.text.includes('.') : /^\d$/.test(k)) p.text += k;
  const v = wrap?.querySelector('.sp-padv'); if (v) v.innerHTML = shown();
}

function enter(mult: number): void {
  const p = cur; if (!p) return;
  const n = Number(p.text);
  closeKeypad();
  if (p.text && p.text !== '-' && Number.isFinite(n)) p.onEnter(n * mult);
}

function hardKey(e: KeyboardEvent): boolean {
  const p = cur!;
  if (e.ctrlKey || e.metaKey || e.altKey) return false;
  if (e.key === 'Escape') { closeKeypad(); return true; }
  if (e.key === 'Enter') {
    const n = Number(p.text);
    enter(p.auto ? p.auto(n) : p.units[p.enterUnit ?? 0][1]);
    return true;
  }
  if (e.key === 'Backspace') { key('bs'); return true; }
  if (e.key === '-' && p.signed) { key('±'); return true; }
  if (/^[0-9.,]$/.test(e.key)) { key(e.key === ',' ? '.' : e.key); return true; }
  const u = p.units.find(([l]) => l.replace('µ', 'u')[0].toLowerCase() === e.key.toLowerCase());
  if (u) { enter(u[1]); return true; }
  return false;
}
