package com.rocketgod.mayhem.ui

/** A label's box on screen, in pixels. */
data class LabelBox(val x: Float, val y: Float, val w: Float, val h: Float)

/**
 * Which labels to draw: in priority order, a label is drawn only when its box clears every label drawn before it by
 * [gap] pixels. Its marker is drawn either way, so a tap or a closer zoom still shows it. Shared by every map that
 * declutters (Dispatch: units a few hundred meters apart piled their numbers on top of each other).
 */
fun declutterLabels(boxes: List<LabelBox>, gap: Float = 2f): BooleanArray {
    val kept = ArrayList<LabelBox>()
    return BooleanArray(boxes.size) { i ->
        val b = boxes[i]
        if (b.w <= 0f) return@BooleanArray false
        val hit = kept.any { k -> b.x < k.x + k.w + gap && k.x < b.x + b.w + gap && b.y < k.y + k.h + gap && k.y < b.y + b.h + gap }
        if (!hit) kept.add(b)
        !hit
    }
}

/** The order labels claim room in: the selected item first, then the talking ones, then the rest as listed. */
fun labelOrder(n: Int, selected: (Int) -> Boolean, talking: (Int) -> Boolean): List<Int> {
    fun rank(i: Int) = if (selected(i)) 0 else if (talking(i)) 1 else 2
    return (0 until n).sortedWith(compareBy({ rank(it) }, { it }))
}
