package com.rocketgod.mayhem.core.pager

/**
 * Networks send a page more than once: a dispatcher repeats a call, a FLEX system re-sends to a pager that missed
 * it. When one copy came in partial (a word lost, or cut where the signal went), another copy of the same page fills
 * it in: a lost word in one is read from the other, and a copy that runs further supplies the rest.
 */
object PageMerge {
    private const val CUT = " …"

    /**
     * [a] and [b] as one page, or null when they are not copies of the same page (or both are already whole, which
     * the feed's fold handles). Characters agree position by position; '?' (a lost word's place) gives way to a
     * real character, and a copy cut short gives way to one that runs on. More than a couple of disagreements, or
     * too little in common to tell, and they are two different pages.
     */
    fun merge(a: PagerPage, b: PagerPage): PagerPage? {
        if (a.capcode != b.capcode || a.kind != b.kind || a.protocol != b.protocol) return null
        if (a.errors == 0 && b.errors == 0) return null
        if (a.text.isBlank() || b.text.isBlank()) return null
        val aCut = a.text.endsWith(CUT); val bCut = b.text.endsWith(CUT)
        val ta = a.text.removeSuffix(CUT); val tb = b.text.removeSuffix(CUT)
        val n = minOf(ta.length, tb.length)
        var agree = 0; var differ = 0
        val out = StringBuilder()
        for (i in 0 until n) {
            val x = ta[i]; val y = tb[i]
            when {
                x == y -> { out.append(x); if (x != '?') agree++ }
                x == '?' -> out.append(y)
                y == '?' -> out.append(x)
                else -> { differ++; out.append(if (a.errors <= b.errors) x else y) }
            }
        }
        // the same page agrees almost everywhere it can be read in both
        if (agree < 6 || differ > maxOf(1, agree / 40)) return null
        // past the shorter: whatever the longer copy has; a whole (uncut) copy's length is the page's length
        val longer = if (ta.length >= tb.length) ta else tb
        val shorterWhole = if (ta.length < tb.length) !aCut && a.errors == 0 else !bCut && b.errors == 0
        if (!shorterWhole) out.append(longer, n, longer.length)
        val cut = when {
            ta.length > tb.length -> aCut
            tb.length > ta.length -> bCut
            else -> aCut && bCut
        } && !shorterWhole
        val lost = Regex("\\?{3}").findAll(out).count()
        val text = out.toString().trimEnd() + if (cut) CUT else ""
        val errors = if (lost == 0 && !cut) 0 else maxOf(1, lost)
        return (if (a.errors <= b.errors) a else b).copy(text = text, errors = errors)
    }
}
