package com.rocketgod.mayhem.core.atsc

/**
 * MPEG-2 transport stream demultiplexer (ITU-T H.222.0 2.4.3): packet counts per PID, continuity, PCR, section
 * reassembly on the table PIDs and PES reassembly on the video PIDs. Decoding comes in bursts, so [gap] marks
 * where the stream stops being contiguous: every partial section and PES is closed there.
 */
/** ATSC TS rate: one 188-byte packet per data segment, 312 of every 313 segments. */
const val TS_BPS = 4.5e6 / 286 * 684 / 832 * 312 / 313 * 188 * 8

class PidStat(var packets: Int = 0, var ccErrors: Int = 0, var scrambled: Int = 0, var pcrs: Int = 0, var pcrIntervalMs: Double = 0.0, var pcrPpm: Double = 0.0, var lastPcr: Long = -1, var lastPcrAt: Long = -1)

class TsDemux {
    /** Packets per PID since the last clear (PID 8192 counts the packets RS could not correct). */
    val pids = LinkedHashMap<Int, PidStat>()
    var total = 0; var bad = 0
    private val cc = HashMap<Int, Int>()
    private val sec = HashMap<Int, SectionAssembler>()
    private class Pes(var buf: ByteArray, var len: Int = 0, var holes: ArrayList<Int> = ArrayList(), var started: Boolean = false)
    private val pes = LinkedHashMap<Int, Pes>()
    /** Absolute packet counter (bursts count on from where the last one ended, plus their gaps). */
    private var at = 0L
    var onSection: ((Int, ByteArray) -> Unit)? = null
    /** A whole PES payload (a copy) and the byte offsets where packets were lost. */
    var onPes: ((Int, ByteArray, List<Int>) -> Unit)? = null
    init { clear() }

    /** Table PIDs to reassemble sections on. */
    fun watchSections(pid: Int) { if (pid !in sec) sec[pid] = SectionAssembler { onSection?.invoke(pid, it) } }
    /** Video PIDs to reassemble PES on. */
    fun watchPes(pid: Int) { if (pid !in pes) pes[pid] = Pes(ByteArray(1 shl 18)) }
    fun unwatchPes(pid: Int) { pes.remove(pid) }
    val pesPids: List<Int> get() = pes.keys.toList()

    private fun stat(pid: Int): PidStat = pids.getOrPut(pid) { PidStat() }

    /** The stream is not contiguous from here: close every partial section and PES. */
    fun gap(packetsMissed: Int = 1_000_000) {
        for (a in sec.values) a.reset()
        for ((pid, p) in pes) flushPes(pid, p, true)
        cc.clear()
        for (s in pids.values) s.lastPcr = -1
        at += packetsMissed
    }

    /** 188-byte packets; a transport error indicator marks a packet RS could not correct. */
    fun feed(ts: ByteArray) {
        val n = ts.size / 188
        for (k in 0 until n) {
            val o = k * 188
            total++
            if (ts.u(o) != 0x47 || ts.u(o + 1) and 0x80 != 0) {
                bad++; stat(8192).packets++
                // the PID of a damaged packet is not known: every stream in progress may have lost one
                for (p in pes.values) if (p.started) p.holes.add(p.len)
                cc.clear()
                at++; continue
            }
            val pid = ((ts.u(o + 1) and 0x1f) shl 8) or ts.u(o + 2); val pusi = ts.u(o + 1) and 0x40 != 0
            val afc = (ts.u(o + 3) shr 4) and 3; val c = ts.u(o + 3) and 15; val st = stat(pid)
            st.packets++
            if (ts.u(o + 3) shr 6 != 0) st.scrambled++
            var pos = 4; var disc = false
            if (afc and 2 != 0) {
                val al = ts.u(o + 4)
                if (al > 0) {
                    val flags = ts.u(o + 5)
                    disc = flags and 0x80 != 0
                    if (flags and 0x10 != 0 && al >= 7) {
                        val base = ts.u(o + 6).toLong() * 33554432L + ((ts.u(o + 7).toLong() shl 17) or (ts.u(o + 8).toLong() shl 9) or (ts.u(o + 9).toLong() shl 1) or (ts.u(o + 10).toLong() shr 7))
                        val pcr = base * 300 + (((ts.u(o + 10) and 1) shl 8) or ts.u(o + 11))
                        if (st.lastPcr >= 0 && at > st.lastPcrAt) {
                            val dt = (pcr - st.lastPcr) / 27e6; val dp = (at - st.lastPcrAt) * 188 * 8 / TS_BPS
                            if (dt > 0 && dt < 0.2) {
                                st.pcrIntervalMs = if (st.pcrIntervalMs != 0.0) 0.9 * st.pcrIntervalMs + 100 * dt else 1000 * dt
                                val ppm = (dt / dp - 1) * 1e6; st.pcrPpm = if (st.pcrs > 1) 0.9 * st.pcrPpm + 0.1 * ppm else ppm
                            }
                        }
                        st.lastPcr = pcr; st.lastPcrAt = at; st.pcrs++
                    }
                }
                pos = 5 + al
            }
            if (pid == 0x1fff || afc and 1 == 0) { at++; continue }
            val last = cc[pid]
            var lost = false
            if (last != null && !disc) {
                if (c == last) { at++; continue }
                if (c != ((last + 1) and 15)) { st.ccErrors++; lost = true }
            }
            cc[pid] = c
            if (pos >= 188) { at++; continue }
            val a = o + pos; val b = o + 188
            sec[pid]?.let { if (lost) it.reset(); it.feed(pusi, ts, a, b) }
            val pe = pes[pid]
            if (pe != null) {
                if (lost && pe.started) pe.holes.add(pe.len)
                if (pusi) {
                    flushPes(pid, pe, false)
                    if (b - a < 9 || ts.u(a) != 0 || ts.u(a + 1) != 0 || ts.u(a + 2) != 1) { at++; continue }
                    val hl = ts.u(a + 8)
                    pe.started = true
                    append(pe, ts, minOf(b, a + 9 + hl), b)
                } else if (pe.started) append(pe, ts, a, b)
            }
            at++
        }
    }

    private fun append(pe: Pes, b: ByteArray, from: Int, to: Int) {
        val n = to - from; if (n <= 0) return
        if (pe.len + n > pe.buf.size) {
            if (pe.buf.size >= 1 shl 22) return
            pe.buf = pe.buf.copyOf(pe.buf.size * 2)
        }
        System.arraycopy(b, from, pe.buf, pe.len, n); pe.len += n
    }
    private fun flushPes(pid: Int, pe: Pes, cut: Boolean) {
        if (pe.started && pe.len > 0) {
            if (cut) pe.holes.add(pe.len)
            onPes?.invoke(pid, pe.buf.copyOf(pe.len), pe.holes)
        }
        pe.len = 0; pe.holes = ArrayList(); pe.started = false
    }

    /** Forgets everything, and watches the PAT and the PSIP base PID again. */
    fun clear() { gap(); pids.clear(); sec.clear(); pes.clear(); total = 0; bad = 0; watchSections(0); watchSections(0x1ffb) }
}
