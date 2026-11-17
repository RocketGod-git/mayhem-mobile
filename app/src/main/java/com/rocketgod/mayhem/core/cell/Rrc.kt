package com.rocketgod.mayhem.core.cell

/** BCCH-DL-SCH decoding (36.331 system information) with the UPER decoder and the 36.331 subset. */
typealias Obj = Map<String, Any?>

private val uper: Uper by lazy { Uper(parseAsn1(RRC_ASN)) }
fun rrcDecoder(): Uper = uper

class BcchResult(val value: Any?, val bitsUsed: Int, val error: String? = null)
fun decodeBcchDlSch(bytes: ByteArray): BcchResult = try {
    val r = rrcDecoder().decode("BCCH-DL-SCH-Message", bytes)
    BcchResult(r.value, r.bitsUsed)
} catch (e: Exception) {
    BcchResult(null, 0, e.message ?: e.javaClass.simpleName)
} catch (e: StackOverflowError) {
    BcchResult(null, 0, "too deep")
}

class MessageParts(val sib1: Obj?, val sibs: List<Pair<String, Obj>>)
/** The SIB1 or the SIB list carried by one decoded BCCH-DL-SCH message. */
@Suppress("UNCHECKED_CAST")
fun messageParts(value: Any?): MessageParts {
    val c1 = ((value as? Obj)?.get("message") as? Obj)?.get("c1") as? Obj ?: return MessageParts(null, emptyList())
    (c1["systemInformationBlockType1"] as? Obj)?.let { return MessageParts(it, emptyList()) }
    val ce = (c1["systemInformation"] as? Obj)?.get("criticalExtensions") as? Obj
    val list = ((ce?.get("systemInformation-r8") as? Obj)?.get("sib-TypeAndInfo") as? List<Any?>) ?: emptyList()
    return MessageParts(null, list.mapNotNull { x -> val m = x as? Obj ?: return@mapNotNull null; val k = m.keys.firstOrNull() ?: return@mapNotNull null; k to ((m[k] as? Obj) ?: emptyMap()) })
}
