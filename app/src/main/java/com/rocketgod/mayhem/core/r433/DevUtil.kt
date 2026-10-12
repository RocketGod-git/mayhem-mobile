package com.rocketgod.mayhem.core.r433

import kotlin.math.floor

/*
 * Small helpers the device decoders share, so each reads like its rtl_433 original. Numbers that JavaScript
 * would treat as doubles stay doubles here; integer arithmetic is only used where the original is integral.
 */

/** Sign-extend the low [bits] of a value, as C does by casting through a narrower signed type. */
fun signed(v: Int, bits: Int): Int { val s = 32 - bits; return (v shl s) shr s }

/** JavaScript's Math.round: halves round toward positive infinity. */
fun jsRound(x: Double): Double = floor(x + 0.5)

fun round1(x: Double): Double = jsRound(x * 10) / 10
fun round2(x: Double): Double = jsRound(x * 100) / 100
fun round3(x: Double): Double = jsRound(x * 1000) / 1000

/** An unsigned 32-bit value from four bytes, big-endian, as a Long (JavaScript's `>>> 0`). */
fun u32be(b: UBytes, at: Int): Long = ((b[at].toLong() shl 24) or (b[at + 1].toLong() shl 16) or (b[at + 2].toLong() shl 8) or b[at + 3].toLong())

/** Lower-case hex, zero-padded to [w] digits. */
fun hexOf(v: Int, w: Int = 2): String = Integer.toHexString(v).padStart(w, '0')
fun hexOf(v: Long, w: Int = 2): String = java.lang.Long.toHexString(v).padStart(w, '0')
fun hexUp(v: Int, w: Int = 2): String = hexOf(v, w).uppercase()
fun hexUp(v: Long, w: Int = 2): String = hexOf(v, w).uppercase()

/** Bytes as lower-case hex. */
fun hexBytes(b: UBytes, n: Int = b.length, at: Int = 0): String { val sb = StringBuilder(); for (i in 0 until n) sb.append(hexOf(b[at + i])); return sb.toString() }

/** JavaScript's Number#toFixed for the usual small precisions. */
fun fixed(x: Double, digits: Int): String = java.math.BigDecimal(x).setScale(digits, java.math.RoundingMode.HALF_UP).toPlainString()

/** A device entry with the usual timings; everything else by name. */
fun dev(
    num: Int, name: String, modulation: Int, shortWidth: Number, longWidth: Number, resetLimit: Number,
    gapLimit: Number = 0, syncWidth: Number = 0, tolerance: Number = 0, disabled: Boolean = false, priority: Int = 0,
    bands: List<Long> = emptyList(), what: String? = null, decode: DecodeFn,
) = RDevice(num, name, modulation, shortWidth.toDouble(), longWidth.toDouble(), resetLimit.toDouble(), gapLimit.toDouble(),
    syncWidth.toDouble(), tolerance.toDouble(), disabled, priority, bands, what, decode)
