package com.rocketgod.mayhem.core.analyzer

import kotlin.math.max
import kotlin.math.min

/*
 * Bursts into transmissions: one press of a key is many bursts.
 *
 * A key sends each press several times, often on several frequencies (the Land Rover sends 6 frames on 3 channels
 * for one press), and the front end captures each as its own burst. Here bursts that follow each other closely
 * (each starting within `gapS` of the last one's end) and belong together become one transmission: the same
 * Devices decoder reading with the same identity, or the same frame (near enough bit for bit). Twin of
 * web/src/dsp/analyzer/group.ts and Group.swift.
 */

/** What grouping needs to know of a burst. */
class GroupIn(
    val id: Int,
    /** Start, seconds (radio or file time), and length, seconds. */
    val t: Double,
    val dur: Double,
    /** Absolute frequency, Hz (or the offset, if the center is unknown). */
    val hz: Double,
    /** The Devices decoders' readings ("car key: Land Rover FSK A824"). */
    val matches: List<String>,
    /** The burst's longest frame. */
    val bits: String,
    /** The file it came from; bursts from different files (or a file and the air) never group. */
    val src: String? = null,
)

class Transmission(
    /** The first burst's id: the transmission's own. */
    val id: Int,
    val ids: List<Int>,
    /** What it is: the decoder's reading when one claimed it, else empty. */
    val label: String,
    /** The channels it was sent on, Hz, low to high: the mean of each cluster of frequencies within 30 kHz. */
    val freqs: List<Double>,
    val t: Double,
    val end: Double,
)

/** Two frames are the same when, lined up, at least 90% of the overlap agrees and the overlap is most of the shorter. */
fun sameFrame(a: String, b: String): Boolean {
    if (a.length < 16 || b.length < 16) return false
    val s = bestShift(a, b, 16)
    val i0 = max(0, s); val i1 = min(a.length, s + b.length)
    if (i1 - i0 < min(a.length, b.length) * 0.8) return false
    var agree = 0
    for (i in i0 until i1) if (a[i] == b[i - s]) agree++
    return agree >= (i1 - i0) * 0.9
}

private class Building(val id: Int, var label: String, val t: Double, var end: Double) {
    val ids = ArrayList<Int>()
    val members = ArrayList<GroupIn>()
}

/** Group bursts (any order) into transmissions, in time order. */
fun groupPresses(bursts: List<GroupIn>, gapS: Double = 0.5): List<Transmission> {
    val sorted = bursts.sortedWith(compareBy<GroupIn>({ it.t }, { it.id }))
    val out = ArrayList<Building>()
    for (b in sorted) {
        var joined = false
        // newest groups first: a burst belongs with the transmission it follows on from
        var g = out.size - 1
        while (g >= 0 && !joined) {
            val tx = out[g]
            if (b.t - tx.end > gapS || (tx.members[0].src ?: "") != (b.src ?: "")) { if (g < out.size - 4) break; g--; continue }
            val byDecoder = b.matches.isNotEmpty() && b.matches.any { m -> tx.members.any { x -> x.matches.any { protocolOf(it) == protocolOf(m) } } }
            val unclaimed = b.matches.isEmpty() || tx.members.all { it.matches.isEmpty() }
            val byFrame = unclaimed && b.bits.isNotEmpty() && tx.members.any { sameFrame(it.bits, b.bits) }
            // a wake-up preamble with no decoder's name on it carries no identity: it goes with the press it is heard in
            fun blank(x: GroupIn) = x.matches.isEmpty() && !informative(x.bits)
            val preamble = blank(b) || tx.members.all { blank(it) }
            if (byDecoder || byFrame || preamble) {
                tx.members.add(b); tx.ids.add(b.id)
                tx.end = max(tx.end, b.t + b.dur)
                if (tx.label.isEmpty() && b.matches.isNotEmpty()) tx.label = b.matches[0]
                joined = true
            }
            g--
        }
        if (!joined) out.add(Building(b.id, b.matches.firstOrNull() ?: "", b.t, b.t + b.dur).also { it.ids.add(b.id); it.members.add(b) })
    }
    return out.map { tx ->
        // a channel is everything heard within 30 kHz (an FSK key's bare carrier sits a tone away from its data)
        val fs = tx.members.map { it.hz }.sorted()
        val groups = ArrayList<ArrayList<Double>>()
        for (f in fs) { val gg = groups.lastOrNull(); if (gg != null && f - gg.last() <= 30_000) gg.add(f) else groups.add(arrayListOf(f)) }
        // named by what most of its frames say: one frame's stale or misread label does not name the press
        val votes = tx.members.mapNotNull { it.matches.firstOrNull() }.groupingBy { it }.eachCount()
        val label = votes.maxByOrNull { it.value }?.key ?: tx.label
        Transmission(tx.id, tx.ids.toList(), label, groups.map { it.sum() / it.size }, tx.t, tx.end)
    }
}

/**
 * A decoder's reading without the ID or code at its end ("car key: Land Rover FSK 80E32F" → "car key: Land Rover
 * FSK"): copies of one press go together even when a decoder reads one of them a bit differently.
 */
fun protocolOf(label: String): String = label.replace(Regex("\\s+\\S*\\d\\S*$"), "")
