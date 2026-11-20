package com.rocketgod.mayhem.core.fleet

import kotlin.math.ceil
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToLong

/**
 * Dispatch calls: every voice grant and every voice transmission heard becomes a call that is on the air until its
 * channel says it ended (a P25 terminator, a DMR terminator) or goes quiet. Talkgroup preferences (mute, hold,
 * priority) and the system lock pick what the receiver follows and what is heard. Each call keeps what the air said
 * about its security (grant service options, link control, encryption sync, privacy header) and the position heard
 * with it. Audio, where a vocoder is registered, is kept per call for replay.
 */

/** Where a call was heard from: the talking unit's own position, or the latest of a talkgroup member's ("unit" or "talkgroup"). */
data class CallPos(val lat: Double, val lon: Double, val unit: Int, val ms: Long, val via: String, val verified: Boolean)
/** One system (or one site of it) the listener locked on. [hz] is its control channel, for tuning back to it. */
data class Lock(val sys: String, val site: String, val label: String, val hz: Long)
data class TgPrefs(val mute: List<String> = emptyList(), val hold: String = "", val prio: List<String> = emptyList(), val lock: Lock? = null)

/** A call as the screen sees it (a copy, safe to hand to another thread). */
data class CallRow(
    val key: String, val sys: String, val proto: String, val tg: Int, val group: Boolean, val src: Int, val srcs: List<Int>, val hz: Long, val slot: Int, val tdma: Boolean,
    val encrypted: Boolean, val emergency: Boolean, val startMs: Long, val lastMs: Long, val endMs: Long, val onAir: Boolean,
    /** Voice heard on the channel itself (P25 voice frames, DMR voice bursts), in ms of speech. */
    val voiceMs: Long, val frames: Int, val levelDb: Double, val peakDb: Double, val site: String, val codec: String,
    /** How the call ended: "terminator", "quiet", "grant ended", or "" while on the air. */
    val end: String, val muted: Boolean, val prio: Boolean, val audioMs: Long, val lcVerified: Boolean, val granted: Boolean,
    /** "id" rows are CW IDs keyed on a channel; a call's own [cwId] is the ID its channel keyed right after it. */
    val kind: String, val cwId: String,
    /** Outside the system lock: shown dimmed, never heard, never followed. */
    val outside: Boolean,
    val pos: CallPos?,
    /** Security as the call states it ("unknown", "clear", "enc"), and what said so. */
    val sec: String, val secFrom: String,
    /** P25 encryption sync (LDU2 or HDU): algorithm ID, key ID (-1 when not heard) and the message indicator in hex. */
    val algId: Int, val keyId: Int, val mi: String,
    /** DMR privacy indicator header as sent, in hex ("" when none was heard). */
    val pi: String,
    /** Decoded audio level, dB below full scale (0 when none yet). */
    val audioDb: Double,
    /** A DMR grant's logical channel, and whether its frequency was learned from what the channels carried. */
    val lpcn: Int, val chDerived: Boolean,
    /** A grant or link control marked the call protected, and no encryption sync has confirmed or denied it. */
    val protectedHint: Boolean,
    /** Vocoder frames decoded, and how many of them were past their error correction (repeated or muted). */
    val decoded: Int, val badFrames: Int,
    /** The talker alias the radio sent (DMR), or "". */
    val alias: String = "",
)

/** What each source on the air said: 1 encrypted, 0 clear, -1 nothing yet; [syncs] the last algorithm IDs read. */
class Said { var grant = -1; var lc = -1; val syncs = ArrayList<Int>(); var from = ""; var pi = false; var emb = -1; var history = false; var histEnc = false; var aie = false }

/** A call the tracker holds (mutable; [row] is the copy handed out). */
class Call(
    var key: String, var sys: String, var proto: String, var tg: Int, var group: Boolean, var src: Int, var hz: Long, var slot: Int, var tdma: Boolean,
    var emergency: Boolean, var startMs: Long, var site: String, var codec: String, var lpcn: Int, var chDerived: Boolean,
) {
    val srcs = ArrayList<Int>()
    var encrypted = false; var lastMs = startMs; var endMs = 0L; var onAir = true; var voiceMs = 0L; var frames = 0
    var levelDb = 0.0; var peakDb = 0.0; var end = ""; var muted = false; var prio = false; var audioMs = 0L; var lcVerified = false; var granted = false
    var kind = "call"; var cwId = ""; var outside = false; var pos: CallPos? = null; var sec = "unknown"; var secFrom = ""; var algId = -1; var keyId = -1; var mi = ""; var pi = ""
    var audioDb = 0.0; var protectedHint = false; var decoded = 0; var badFrames = 0; var alias = ""
    var grantMs = 0L; var voiceAt = 0L; var audioAt = 0L
    val pcm = ArrayList<FloatArray>(); var pcmN = 0
    var codecInst: VoiceCodec? = null
    var held = ArrayList<IntArray>()
    val said = Said()
    var wait = ArrayList<FloatArray>()
    fun row() = CallRow(key, sys, proto, tg, group, src, srcs.toList(), hz, slot, tdma, encrypted, emergency, startMs, lastMs, endMs, onAir, voiceMs, frames, levelDb, peakDb,
        site, codec, end, muted, prio, audioMs, lcVerified, granted, kind, cwId, outside, pos, sec, secFrom, algId, keyId, mi, pi, audioDb, lpcn, chDerived, protectedHint, decoded, badFrames, alias)
}

/** A grant as the control channel gave it. */
data class GrantIn(val sys: String, val proto: String, val tg: Int, val group: Boolean, val src: Int, val hz: Long, val slot: Int, val tdma: Boolean,
                   val encrypted: Boolean, val emergency: Boolean, val site: String, val lpcn: Int? = null, val chDerived: Boolean? = null, val efr: Boolean = false)
/** Link control as the voice channel gave it. */
data class LcIn(val group: Boolean, val dst: Int, val src: Int, val emergency: Boolean, val privacy: Boolean)
/** What one source on the air said about a call's security. */
data class SecIn(val enc: Boolean, val from: String, val algId: Int? = null, val keyId: Int? = null, val mi: String? = null, val pi: String? = null)

const val AUDIO_CAP_S = 120
/** Frames held while a call's security is not yet known (360 ms); past that a call nothing marked encrypted plays. */
const val HOLD_FRAMES = 18
/**
 * On P25 a clear grant or link control waits three LDUs (540 ms) for the encryption sync: the sync is read at the end
 * of an LDU2, after its nine frames, so a call joined at its LDU1 has the sync in hand before this many frames.
 */
const val P25_HOLD_FRAMES = 27
/** Encrypted calls, and calls still waiting on their security, rank below every clear call. */
fun quietRank(encrypted: Boolean, sec: String): Int = if (encrypted) 2 else if (sec == "unknown") 1 else 0
private const val CALLS_KEPT = 200
private const val AUDIO_CALLS = 30
private const val QUIET_HEARD_MS = 1_200L
private const val QUIET_GRANT_MS = 3_000L
private const val TRAIL_MS = 2_000L
private const val ID_AFTER_MS = 15_000L
/**
 * How long the call heard keeps the audio with no speech frame: P25 Phase 1 hands over nine frames an LDU (180 ms), so
 * one lost LDU must not cost it; Phase 2 and DMR bring frames every 60 ms. Past this a call with speech takes over, so
 * a call that holds the channel with silence, or frames that all fail, never keeps NOW PLAYING quiet.
 */
/** The vocoder of a call: IMBE for P25 Phase 1, AMBE+2 for DMR and Phase 2, the TETRA ACELP codec for TETRA. */
fun liveMs(proto: String, tdma: Boolean): Long = if (proto == "P25" && !tdma) 600L else 360L
/**
 * The vocoder of a call: IMBE for P25 Phase 1, AMBE+2 half rate for DMR, Phase 2 and NXDN, the TETRA ACELP codec for
 * TETRA. NXDN's EFR (its 9600 bps full rate) is the IMBE frame: [efr].
 */
fun codecOf(proto: String, tdma: Boolean, efr: Boolean = false): String =
    if (proto == "TETRA") CodecIds.TETRA else if ((proto == "P25" && !tdma) || (proto == "NXDN" && efr)) CodecIds.IMBE else CodecIds.AMBE2

private fun callGrid(hz: Long): Long = Math.round(hz / 6250.0) * 6250
/** How long the talkgroup of a call just heard keeps first claim on the audio: the reply in a conversation. */
const val CONVERSATION_MS = 2_000L
/** A call waiting out another talkgroup's conversation keeps this many frames (20 ms each) to play when its turn comes. */
private val WAIT_FRAMES = ceil(CONVERSATION_MS / 20.0).toInt() + 25
/** Outside a lock: another system, or another site of the locked one (a call with no site label is kept). */
fun outsideLock(sys: String, site: String, lock: Lock?): Boolean =
    lock != null && (sys != lock.sys || (lock.site.isNotEmpty() && site.isNotEmpty() && site != lock.site))

class CallTracker(private val now: () -> Long) {
    val calls = ArrayList<Call>()
    var prefs = TgPrefs(); private set
    /** The call being heard: the first to bring audio keeps it until it ends; priority (then emergency) takes over. */
    var playing = ""; private set
    private class Heard(val sys: String, val tg: Int, val group: Boolean, val ms: Long)
    /** The talkgroup of the call last heard, and when it ended: its next call gets the audio first for a moment. */
    private var lastHeard: Heard? = null
    /** Talkgroups whose calls a sync (ALGID other than 0x80) marked encrypted, and when. */
    private val encTgs = HashMap<String, Long>()
    /** Live audio out, 8 kHz: every decoded frame of the call being heard. */
    var onAudio: ((FloatArray, Call) -> Unit)? = null
    /** The call being heard went off the air or out of hearing (so its audio can fade out instead of stopping dead). */
    var onEnd: ((Call) -> Unit)? = null

    fun tgKey(sys: String, tg: Int, group: Boolean): String = if (group) "$sys/$tg" else "$sys/u$tg"
    fun tgKey(c: Call) = tgKey(c.sys, c.tg, c.group)
    fun tgKey(c: CallRow) = tgKey(c.sys, c.tg, c.group)
    fun muted(c: Call): Boolean = tgKey(c) in prefs.mute || (prefs.hold.isNotEmpty() && prefs.hold != tgKey(c))
    private fun label(c: Call) { c.muted = muted(c); c.prio = tgKey(c) in prefs.prio; c.outside = outsideLock(c.sys, c.site, prefs.lock) }

    private fun find(sys: String, hz: Long, slot: Int, onAir: Boolean = true): Call? {
        val k = callGrid(hz)
        return calls.firstOrNull { it.kind == "call" && (!onAir || it.onAir) && (sys.isEmpty() || it.sys.isEmpty() || it.sys == sys) && it.hz > 0 && callGrid(it.hz) == k && it.slot == slot }
    }
    private fun create(sys: String, proto: String, hz: Long, slot: Int, codec: String, now: Long, tg: Int = 0, group: Boolean = true, src: Int = 0, tdma: Boolean = false,
                       emergency: Boolean = false, site: String = "", lpcn: Int = -1, chDerived: Boolean = false): Call {
        val c = Call("$sys|$now|$hz|$slot", sys, proto, tg, group, src, hz, slot, tdma, emergency, now, site, codec, lpcn, chDerived)
        if (src != 0) c.srcs.add(src)
        label(c)
        calls.add(0, c)
        trim()
        return c
    }
    private fun trim() {
        var ended = 0
        val it = calls.iterator()
        while (it.hasNext()) { val c = it.next(); if (!c.onAir && ++ended > CALLS_KEPT) it.remove() }
        var withAudio = 0
        for (c in calls) if (c.pcmN != 0 && ++withAudio > AUDIO_CALLS) { c.pcm.clear(); c.pcmN = 0 }
    }

    /** A voice grant (or grant update) on the control channel. */
    fun grant(g: GrantIn, now: Long = this.now()): Call? {
        if (g.tg == 0 && g.hz == 0L) return null
        var c = calls.firstOrNull { x -> x.kind == "call" && x.onAir && x.sys == g.sys && x.tg == g.tg && x.group == g.group && (x.hz == 0L || g.hz == 0L || callGrid(x.hz) == callGrid(g.hz)) && (x.slot == g.slot || x.hz == 0L || g.hz == 0L) }
        if (c == null && g.hz != 0L) {
            // voice that arrived before its grant (or a grant for a channel already carrying an unlabeled call)
            val v = find(g.sys, g.hz, g.slot)
            if (v != null && v.tg == 0) c = v
        }
        // grant updates trail a call for a moment after its terminator: they do not open it again
        if (c == null && calls.any { x -> x.kind == "call" && !x.onAir && x.end == "terminator" && now - x.endMs < TRAIL_MS && x.sys == g.sys && x.tg == g.tg && (g.hz == 0L || x.hz == 0L || callGrid(x.hz) == callGrid(g.hz)) }) return null
        val codec = codecOf(g.proto, g.tdma, g.efr)
        if (c == null) c = create(g.sys, g.proto, g.hz, g.slot, codec, now, g.tg, g.group, g.src, g.tdma, g.emergency, g.site, g.lpcn ?: -1, g.chDerived ?: false)
        c.tg = if (g.tg != 0) g.tg else c.tg; c.group = g.group; c.sys = g.sys.ifEmpty { c.sys }; if (g.hz != 0L) { c.hz = g.hz; c.slot = g.slot }; c.tdma = g.tdma; c.codec = codec
        if (g.lpcn != null && g.lpcn >= 0) c.lpcn = g.lpcn
        if (g.chDerived == true) c.chDerived = true
        if (g.src != 0) addSrc(c, g.src)
        c.emergency = c.emergency || g.emergency; c.site = g.site.ifEmpty { c.site }
        // a P25 grant's service options say whether the call is encrypted; a DMR grant says nothing either way
        if (g.encrypted) security(c, SecIn(true, "grant"))
        else if (g.proto == "P25" || g.proto == "TETRA") security(c, SecIn(false, "grant"))
        c.grantMs = now; c.lastMs = now; c.granted = true
        label(c)
        return c
    }
    private fun addSrc(c: Call, src: Int) { c.src = src; if (src !in c.srcs) { c.srcs.add(src); if (c.srcs.size > 12) c.srcs.removeAt(0) } }

    /** Voice on a channel: a P25 voice frame (180 ms of speech) or a DMR voice burst (60 ms). */
    fun voice(sys: String, proto: String, hz: Long, slot: Int, ms: Long, now: Long = this.now(), tdma: Boolean = false): Call {
        val c = find(sys, hz, slot) ?: create(sys, proto, hz, slot, codecOf(proto, tdma), now, tdma = tdma)
        c.frames++; c.voiceMs += ms; c.voiceAt = now; c.lastMs = now
        if (sys.isNotEmpty() && c.sys.isEmpty()) { c.sys = sys; label(c) }
        return c
    }
    /** Link control read on the voice channel (DMR voice LC header or terminator, P25 LDU1): who is talking to whom. */
    fun lc(sys: String, hz: Long, slot: Int, lc: LcIn, now: Long = this.now(), proto: String = "DMR", tdma: Boolean = false): Call {
        var c = find(sys, hz, slot)
        if (c != null && c.tg != 0 && c.tg != lc.dst) { finish(c, "terminator", now); c = null }
        if (c == null) {
            // a granted call whose channel is not resolved yet (a DMR logical channel): the voice link control places it
            c = calls.firstOrNull { x -> x.kind == "call" && x.onAir && x.proto == proto && x.hz == 0L && x.tg == lc.dst && x.group == lc.group && (sys.isEmpty() || x.sys.isEmpty() || x.sys == sys) }
            if (c != null) { c.hz = hz; c.slot = slot }
        }
        if (c == null) c = create(sys, proto, hz, slot, codecOf(proto, tdma), now, lc.dst, lc.group, tdma = tdma)
        c.tg = lc.dst; c.group = lc.group; addSrc(c, lc.src); c.emergency = c.emergency || lc.emergency; c.lcVerified = true
        if (sys.isNotEmpty() && c.sys.isEmpty()) c.sys = sys
        if (!tdma && proto != "NXDN") security(c, SecIn(lc.privacy, if (proto == "P25") "LDU1" else "LC"))
        c.lastMs = now; c.voiceAt = max(c.voiceAt, now)
        label(c)
        return c
    }
    /**
     * What the air says about a call's security, each source kept, and the call's state worked out again from all of
     * them. A call is ENCRYPTED only when the radio says so positively:
     *  - P25: an encryption sync (LDU2) or header that passed its Reed-Solomon check with an ALGID other than 0x80.
     *    ALGID 0x80 is clear, whatever else was said. A grant or link control marked protected, with no sync to
     *    confirm it, is only "protected?": the call plays, and goes quiet the moment a sync says encrypted.
     *  - DMR: the link control's privacy bit (Reed-Solomon checked), the privacy indicator header (CRC checked) or the
     *    EMB privacy bit (its (16,7) check).
     * Frames that fail their codes, or a call with nothing readable, never make a call encrypted.
     */
    fun security(c: Call, s: SecIn) {
        val said = c.said; val sync = s.from == "LDU2" || s.from == "HDU" || s.from == "MAC" || s.from == "ESS"
        if (c.tdma && c.tg != 0 && !said.history && encTgs.containsKey(tgKey(c))) said.history = true
        if (sync && s.algId != null && s.algId >= 0) {
            said.syncs.add(s.algId); if (said.syncs.size > 2) said.syncs.removeAt(0); c.algId = s.algId; c.keyId = s.keyId ?: c.keyId; if (s.mi != null) c.mi = s.mi; said.from = s.from
        } else if (s.from == "grant") said.grant = if (s.enc) 1 else if (said.grant == 1) 1 else 0
        else if (s.from == "LDU1" || s.from == "LC") said.lc = if (s.enc) 1 else if (said.lc == 1) 1 else 0
        else if (s.from == "PI") { said.pi = true; if (!s.pi.isNullOrEmpty()) c.pi = s.pi; if (s.algId != null) c.algId = s.algId; if (s.keyId != null) c.keyId = s.keyId; if (!s.mi.isNullOrEmpty()) c.mi = s.mi }
        else if (s.from == "EMB") said.emb = if (s.enc) 1 else if (said.emb == 1) 1 else 0
        else if (s.from == "history") said.histEnc = true
        else if (s.from == "AIE") said.aie = true
        // NXDN: the cipher type of a VCALL (SACCH or FACCH1, CRC checked) or of a Type-D INFO1 (SCCH, CRC checked)
        else if (s.from == "VCALL" || s.from == "SCCH") { said.lc = if (s.enc) 1 else if (said.lc == 1) 1 else 0; said.from = s.from; if (s.enc) { if (s.algId != null) c.algId = s.algId; if (s.keyId != null) c.keyId = s.keyId } }
        var sec = "unknown"; var from = ""
        if (c.proto == "P25") {
            val last = if (said.syncs.isNotEmpty()) said.syncs.last() else -1
            if (last >= 0) { sec = if (last == 0x80) "clear" else "enc"; from = said.from }
            // a Phase 2 talkgroup whose earlier calls were encrypted waits for its push to talk or ESS, and past a second
            // without either is taken as encrypted
            else if (said.histEnc) { sec = "enc"; from = "history" }
            else if (said.history && c.tdma) sec = "unknown"
            else if (said.grant >= 0 || said.lc >= 0) { sec = "clear"; from = if (said.grant >= 0) "grant" else "LDU1" }
            c.protectedHint = last < 0 && (said.grant == 1 || said.lc == 1)
        } else if (c.proto == "TETRA") {
            // TETRA: the end-to-end encryption flag of the call's set-up (or the encryption control of a transmission grant),
            // or signalling encrypted on the air interface of a cell that offers it
            if (said.grant == 1 || said.aie) { sec = "enc"; from = if (said.aie) "AIE" else "grant" }
            else if (said.grant == 0) { sec = "clear"; from = "grant" }
            c.protectedHint = false
        } else if (c.proto == "NXDN") {
            // a cipher type other than 00 is encrypted (scramble, DES, AES); 00 says clear (TS 1-A 6.5.27)
            if (said.lc == 1) { sec = "enc"; from = said.from } else if (said.lc == 0) { sec = "clear"; from = said.from }
            c.protectedHint = false
        } else {
            if (said.lc == 1 || said.pi || said.emb == 1) { sec = "enc"; from = if (said.pi) "PI" else if (said.lc == 1) "LC" else "EMB" }
            // an EMB privacy bit of 0 does not make a call clear: Motorola's privacy leaves it 0, the LC's service options say it
            else if (said.lc == 0) { sec = "clear"; from = "LC" }
            c.protectedHint = false
        }
        val was = c.sec
        if (sec == "enc" && sync && c.tg != 0) encTgs[tgKey(c)] = now()
        c.sec = sec; c.secFrom = if (sec == "unknown") c.secFrom else from; c.encrypted = sec == "enc"
        if (sec == "enc") { c.held = ArrayList(); c.wait = ArrayList(); if (playing == c.key) { playing = ""; onEnd?.invoke(c) } }
        else if (sec == "clear" && was != "clear") release(c)
    }
    /** The call's vocoder, before any of its frames were decoded (an NXDN call that turns out to be EFR). */
    fun setCodec(c: Call, codec: String) { if (c.codec != codec && c.codecInst == null) { c.codec = codec; c.held = ArrayList() } }
    /** Security of the call on the air on a channel, if there is one. */
    fun securityAt(sys: String, hz: Long, slot: Int, s: SecIn): Call? { val c = find(sys, hz, slot); if (c != null) security(c, s); return c }
    /** A CW ID keyed on a channel: logged as its own row, and on the call that channel just carried. */
    fun cwId(sys: String, hz: Long, text: String, now: Long = this.now()) {
        val k = callGrid(hz)
        val last = calls.firstOrNull { it.kind == "call" && it.hz > 0 && callGrid(it.hz) == k && (it.onAir || now - it.endMs < ID_AFTER_MS) }
        if (last != null) last.cwId = text
        val r = create(sys.ifEmpty { last?.sys ?: "" }, last?.proto ?: "P25", hz, 0, CodecIds.IMBE, now)
        r.kind = "id"; r.cwId = text; r.onAir = false; r.endMs = now; r.end = "cw id"
        trim()
    }
    fun onAirAt(sys: String, hz: Long, slot: Int): Boolean = find(sys, hz, slot) != null
    /** The call on the air on a channel (and slot), if any. */
    fun at(sys: String, hz: Long, slot: Int): Call? = find(sys, hz, slot)
    /** The channel sent its end of transmission. */
    fun terminate(sys: String, hz: Long, slot: Int, now: Long = this.now()) { find(sys, hz, slot)?.let { finish(it, "terminator", now) } }
    /** Where the call was heard from; kept with the call once it ends. */
    fun place(c: Call, pos: CallPos?) { if (pos != null) c.pos = pos }
    /**
     * Vocoder frames of a call: decoded where a codec is registered and the call is in the clear. Until something on
     * the air says whether the call is encrypted its frames wait (at most [P25_HOLD_FRAMES]).
     */
    fun frames(c: Call, frames: List<IntArray>) {
        if (c.encrypted || c.muted || c.outside) return
        if (c.sec == "unknown") {
            c.held.addAll(frames)
            // nothing checked on the air has named the call yet (no grant, no link control, no EMB that passed its check):
            // it waits, its oldest frames going first. A false DMR detection or a channel of noise never takes the audio.
            if (c.held.size > P25_HOLD_FRAMES) c.held.subList(0, c.held.size - P25_HOLD_FRAMES).clear()
            return
        }
        decode(c, frames)
    }
    private fun release(c: Call) {
        val h = c.held; c.held = ArrayList()
        if (h.isNotEmpty() && !c.encrypted && !c.muted && !c.outside) decode(c, h)
    }
    private fun decode(c: Call, frames: List<IntArray>) {
        if (c.codecInst == null) c.codecInst = makeCodec(c.codec)
        val k = c.codecInst ?: return
        val now = now()
        for (f in frames) {
            val pcm = k.decode(f) ?: continue
            c.decoded++; if (k.bad) c.badFrames++
            if (c.pcmN < AUDIO_CAP_S * 8000) { c.pcm.add(pcm); c.pcmN += pcm.size; c.audioMs = (c.pcmN / 8.0).roundToLong() }
            var e = 0.0; for (v in pcm) e += v * v
            val db = 10 * log10(e / pcm.size + 1e-9)
            c.audioDb = if (c.audioDb != 0.0) c.audioDb + 0.3 * (db - c.audioDb) else db
            // only a frame that came through its codes and carries speech counts as audio: a weak call's muted and repeated
            // frames, and a keyed radio's silence frames, neither take the audio nor keep it
            val good = !k.bad && !k.silent
            if (good) c.audioAt = now
            if (playing == c.key) { onAudio?.invoke(pcm, c); continue }
            val r = if (good) choose(c, now) else if (c.wait.isNotEmpty()) "wait" else "no"
            when (r) {
                "yes" -> { for (w in c.wait) onAudio?.invoke(w, c); c.wait = ArrayList(); onAudio?.invoke(pcm, c) }
                "wait" -> { c.wait.add(pcm); if (c.wait.size > WAIT_FRAMES) c.wait.removeAt(0) }
                else -> c.wait = ArrayList()
            }
        }
    }
    /**
     * Whether [c] is the call heard: it is when nothing else is, and it takes over for priority or emergency. The call
     * heard keeps the audio while it is on the air (its terminator, or 1.2 s with no voice frame, ends it) and has
     * brought speech within [liveMs]: a lost LDU or a frame that failed its codes does not hand it to another call.
     */
    private fun choose(c: Call, now: Long): String {
        if (playing == c.key) return "yes"
        val cur = if (playing.isNotEmpty()) calls.firstOrNull { it.key == playing } else null
        val live = cur != null && cur.onAir && !cur.muted && !cur.outside && !cur.encrypted && now - cur.audioAt < liveMs(cur.proto, cur.tdma)
        val wins = cur != null && ((c.prio && !cur.prio) || (c.emergency && !cur.emergency && !cur.prio))
        if (live && !wins) return "no"
        // the conversation goes on: for 2 s after the call heard ends, the same talkgroup's next call gets the audio
        // first over a call that starts in that time. That call's speech is kept, not lost: it plays from its start if no
        // reply comes. A call already on the air when the heard one ended goes straight on (holding it would cost audio).
        val h = lastHeard; val same = h != null && c.tg == h.tg && c.group == h.group && (c.sys.isEmpty() || h.sys.isEmpty() || c.sys == h.sys)
        val curOn = cur?.onAir == true
        if (!curOn && h != null && now - h.ms < CONVERSATION_MS && !same && c.startMs >= h.ms && !c.prio && !c.emergency) return "wait"
        // past the window, the call that has waited longest goes first, from the start of what it kept
        if (!curOn && !(h != null && now - h.ms < CONVERSATION_MS && same)) {
            val first = calls.firstOrNull { it !== c && it.onAir && it.wait.size > c.wait.size && !it.encrypted && !it.muted && !it.outside }
            if (first != null) { playing = first.key; for (w in first.wait) onAudio?.invoke(w, first); first.wait = ArrayList(); return "no" }
        }
        if (cur != null && live) onEnd?.invoke(cur)
        playing = c.key
        return "yes"
    }
    /**
     * The conversation window is over and nothing plays: the speech kept by the call that waited longest plays now, even
     * when that call has already ended (a short call in the window is heard rather than lost).
     */
    private fun waitOut(now: Long) {
        val h = lastHeard
        if (playing.isNotEmpty() || h == null || now - h.ms < CONVERSATION_MS) return
        val x = calls.filter { it.wait.isNotEmpty() && !it.encrypted && !it.muted && !it.outside }.minByOrNull { it.startMs }
        for (c in calls) if (c !== x && !c.onAir) c.wait = ArrayList()
        if (x == null) return
        val w = x.wait; x.wait = ArrayList()
        if (x.onAir) playing = x.key
        for (p in w) onAudio?.invoke(p, x)
        if (!x.onAir) onEnd?.invoke(x)
    }
    private fun finish(c: Call, why: String, now: Long) {
        if (!c.onAir) return
        c.onAir = false; c.endMs = now; c.end = why; c.codecInst = null; c.held = ArrayList()
        // the conversation's window runs from the call's last voice (a call that went quiet ends 1.2 s after it)
        if (playing == c.key) { playing = ""; lastHeard = Heard(c.sys, c.tg, c.group, min(now, if (c.voiceAt != 0L) c.voiceAt else now)); onEnd?.invoke(c) }
        trim()
    }
    /** Calls go off the air when nothing has kept them alive. [level] reads the carrier level for a frequency. */
    fun tick(level: (Long) -> Double?, now: Long = this.now()) {
        waitOut(now)
        for (c in calls.toList()) {
            if (!c.onAir) continue
            val l = if (c.hz != 0L) level(c.hz) else null
            if (l != null) { c.levelDb = l; c.peakDb = max(c.peakDb, l) }
            if (c.tdma && c.tg != 0 && c.sec != "enc" && c.said.syncs.isEmpty()) {
                if (!c.said.history && encTgs.containsKey(tgKey(c))) { c.said.history = true; security(c, SecIn(false, "recheck")) }
                if (c.said.history && now - c.startMs > 1_000) security(c, SecIn(true, "history"))
            }
            val heard = c.voiceAt > 0
            if (if (heard) now - c.voiceAt > QUIET_HEARD_MS && now - c.grantMs > QUIET_HEARD_MS else now - c.grantMs > QUIET_GRANT_MS) finish(c, if (heard) "quiet" else "grant ended", now)
        }
    }
    fun setPrefs(p: TgPrefs) {
        prefs = TgPrefs(p.mute.toList(), p.hold, p.prio.toList(), p.lock?.copy())
        for (c in calls) label(c)
        val cur = calls.firstOrNull { it.key == playing }
        if (cur != null && (cur.muted || cur.outside)) { playing = ""; onEnd?.invoke(cur) }
    }
    /** On-air calls in the order they are worth listening to: priority, emergency, then newest. Muted and locked-out ones last. */
    fun ranked(): List<Call> = calls.filter { it.onAir }.sortedWith(
        compareBy<Call> { it.outside }.thenBy { it.muted }.thenBy { it.encrypted }.thenByDescending { it.prio }.thenByDescending { it.emergency }.thenByDescending { it.startMs })
    /** The call a single-channel receiver should go to: the best one outside [inSpan] that is not muted or locked out. */
    fun followTarget(inSpan: (Long) -> Boolean, worth: (Call) -> Boolean = { true }): Call? =
        ranked().firstOrNull { !it.muted && !it.outside && !it.encrypted && it.hz > 0 && !inSpan(it.hz) && worth(it) }
    fun audioOf(key: String): FloatArray? {
        val c = calls.firstOrNull { it.key == key } ?: return null
        if (c.pcmN == 0) return null
        val out = FloatArray(c.pcmN); var p = 0; for (b in c.pcm) { b.copyInto(out, p); p += b.size }
        return out
    }
    fun rows(n: Int = 80): List<CallRow> = (ranked() + calls.filter { !it.onAir }.take(n)).map { it.row() }
    fun clear() { calls.clear(); playing = "" }
}
