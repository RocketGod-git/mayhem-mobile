package com.rocketgod.mayhem.core.pager

/** What a page carries. */
enum class PageKind(val label: String) {
    ALPHA("ALPHA"), NUMERIC("NUM"), TONE("TONE"), BINARY("BIN"), SECURE("SECURE"), INSTRUCTION("INSTR")
}

/**
 * One decoded page, straight from a decoder. [rate] is the on-air speed ("1600", "6400", "1200"...), [where] the
 * protocol's own position stamp (FLEX cycle/frame/phase, POCSAG function), [errors] how many words needed or
 * failed correction.
 */
data class PagerPage(
    val protocol: String,
    val rate: String,
    val capcode: Long,
    val kind: PageKind,
    val text: String,
    val where: String = "",
    val errors: Int = 0,
)

/** Where decoders report: a page, and every sync they lock (so the hunter knows a channel is really a pager). */
interface PagerSink {
    fun onPage(p: PagerPage)
    fun onSync(protocol: String, rate: String) {}
}
