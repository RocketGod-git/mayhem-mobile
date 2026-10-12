package com.rocketgod.mayhem.core.apps.ism

/**
 * Pulse-duration protocol framework (Mayhem fprotos/, Flipper SubGhz lineage, rtl_433 spirit): every protocol is
 * a state machine fed (level, duration µs) pulses by the OOK detector in [IsmDecoder]; when a frame verifies it
 * calls back with the raw bits in [decodeData], and the family field decoders turn those into readings.
 */
object Fam { const val WEATHER = 0; const val REMOTE = 1; const val CAR = 2 }

/** Weather sensor types (Mayhem FPROTO_WEATHER_SENSOR values). */
object W {
    const val NEXUS_TH = 1; const val ACURITE_592TXR = 2; const val ACURITE_606TX = 3; const val ACURITE_609TX = 4; const val AMBIENT = 5
    const val AURIOL_AHFL = 6; const val AURIOL_TH = 7; const val GT_WT02 = 8; const val GT_WT03 = 9; const val INFACTORY = 10
    const val LACROSSE_TX = 11; const val LACROSSE_TX141THBV2 = 12; const val OREGON2 = 13; const val OREGON3 = 14; const val OREGON_V1 = 15
    const val THERMOPRO_TX4 = 16; const val TX_8300 = 17; const val WENDOX_W6726 = 18; const val ACURITE_986 = 19; const val KEDSUM = 20
    const val ACURITE_5IN1 = 21; const val EMOS_E601X = 22; const val SOLIGHT_TE44 = 23; const val BRESSER_3CH = 24; const val BRESSER_3CH_V1 = 25
    const val VAUNO_EN8822 = 26; const val OREGON2B = 27
}

/** Remote / sub-GHz device types (Mayhem FPROTO_SUBGHZD_SENSOR values, in enum order). */
object S {
    const val PRINCETON = 1; const val BETT = 2; const val CAME = 3; const val PRASTEL = 4; const val AIRFORCE = 5; const val CAME_ATOMO = 6
    const val CAME_TWEE = 7; const val CHAMBCODE = 8; const val CLEMSA = 9; const val DOITRAND = 10; const val DOOYA = 11; const val FAAC = 12
    const val GATE_TX = 13; const val HOLTEK = 14; const val HOLTEK_HT12X = 15; const val HONEYWELL = 16; const val HONEYWELL_WDB = 17
    const val HORMANN = 18; const val IDO = 19; const val INTERTECHNO_V3 = 20; const val KEELOQ = 21; const val KINGGATES_STYLO_4K = 22
    const val LEGRAND = 23; const val LINEAR = 24; const val LINEAR_DELTA3 = 25; const val MAGELLAN = 26; const val MARANTEC = 27
    const val MASTERCODE = 28; const val MEGACODE = 29; const val NERO_RADIO = 30; const val NERO_SKETCH = 31; const val NICE_FLO = 32
    const val NICE_FLORS = 33; const val PHOENIX_V2 = 34; const val POWER_SMART = 35; const val SECPLUS_V1 = 36; const val SECPLUS_V2 = 37
    const val SMC5326 = 38; const val STARLINE = 39; const val X10 = 40; const val SOMFY_KEYTIS = 41; const val SOMFY_TELIS = 42
    const val GANGQI = 43; const val MARANTEC24 = 44; const val HOLTEK_HT6P20B = 45; const val RESTAURANT_PAGER = 46; const val SUPERROLLO = 47
}

/** Car key types (Mayhem FPROTO_SUBCAR_SENSOR values). */
object C {
    const val SUZUKI = 1; const val VW = 2; const val SUBARU = 3; const val KIA_V5 = 4; const val KIA_V3V4 = 5; const val KIA_V2 = 6
    const val KIA_V1 = 7; const val KIA_V0 = 8; const val FORD_V0 = 9; const val FIAT_V0 = 10; const val BMW_V0 = 11
}

/** Manchester decoder state (Flipper manchester_decoder). */
class Manchester {
    var state = MID1
    var data = false
    /** Feed an event; returns true when a bit was produced (read it from [data]). */
    fun advance(event: Int): Boolean {
        var result = false
        val newState: Int
        if (event == EVENT_RESET) newState = MID1
        else {
            var ns = (TRANSITIONS[state] shr event) and 0x3
            if (ns == state) ns = MID1
            else {
                if (ns == MID0) { data = false; result = true }
                else if (ns == MID1) { data = true; result = true }
            }
            newState = ns
        }
        state = newState
        return result
    }
    companion object {
        const val START1 = 0; const val MID1 = 1; const val MID0 = 2; const val START0 = 3
        const val EVENT_SHORT_LOW = 0; const val EVENT_SHORT_HIGH = 2; const val EVENT_LONG_LOW = 4; const val EVENT_LONG_HIGH = 6; const val EVENT_RESET = 8
        private val TRANSITIONS = intArrayOf(0b00000001, 0b10010001, 0b10011011, 0b11111011)
    }
}

/** FProtoGeneral helpers. Byte arrays are IntArrays holding 0..255. */
object FG {
    fun dd(x: Int, y: Int): Int = if (x < y) y - x else x - y
    fun bitRead(v: Long, bit: Int): Int = ((v ushr bit) and 1L).toInt()
    fun parity(key: Long, bitCount: Int): Int { var p = 0; for (i in 0 until bitCount) p += bitRead(key, i); return p and 1 }
    fun addBytes(msg: IntArray, size: Int): Int { var r = 0; for (i in 0 until size) r += msg[i]; return r and 0xff }
    fun parity8(b: Int): Int { var x = b xor (b ushr 4); x = x and 0xf; return (0x6996 ushr x) and 1 }
    fun parityBytes(msg: IntArray, size: Int): Int { var r = 0; for (i in 0 until size) r = r xor parity8(msg[i]); return r }
    fun lfsrDigest8(msg: IntArray, size: Int, gen: Int, keyIn: Int): Int {
        var sum = 0; var key = keyIn
        for (b in 0 until size) { val data = msg[b]; for (i in 7 downTo 0) { if ((data ushr i) and 1 != 0) sum = sum xor key; key = if (key and 1 != 0) (key ushr 1) xor gen else key ushr 1 } }
        return sum and 0xff
    }
    fun lfsrDigest8Reflect(msg: IntArray, size: Int, gen: Int, keyIn: Int): Int {
        var sum = 0; var key = keyIn
        for (b in size - 1 downTo 0) { val data = msg[b]; for (i in 0 until 8) { if ((data ushr i) and 1 != 0) sum = sum xor key; key = if (key and 0x80 != 0) ((key shl 1) xor gen) and 0xff else (key shl 1) and 0xff } }
        return sum and 0xff
    }
    fun crc4(msg: IntArray, size: Int, polynomial: Int, init: Int): Int {
        var rem = (init shl 4) and 0xff; val poly = (polynomial shl 4) and 0xff
        for (b in 0 until size) { rem = rem xor msg[b]; for (bit in 0 until 8) rem = if (rem and 0x80 != 0) ((rem shl 1) xor poly) and 0xff else (rem shl 1) and 0xff }
        return (rem ushr 4) and 0x0f
    }
    fun crc8(msg: IntArray, size: Int, polynomial: Int, init: Int): Int {
        var rem = init and 0xff
        for (b in 0 until size) { rem = rem xor msg[b]; for (bit in 0 until 8) rem = if (rem and 0x80 != 0) ((rem shl 1) xor polynomial) and 0xff else (rem shl 1) and 0xff }
        return rem
    }
    fun reverseKey(key: Long, bitCount: Int): Long { var r = 0L; for (i in 0 until bitCount) r = (r shl 1) or bitRead(key, i).toLong(); return r }
    fun fToC(f: Float): Float = (f - 32f) / 1.8f
}

/** One protocol decoder. [sensorType] may be changed by a protocol that covers several variants. */
abstract class FProto(val family: Int, initialType: Int) {
    var sensorType = initialType
    var decodeData = 0L
    var decodeData2 = 0L
    var decodeCountBit = 0
    var dataCountBit = 0
    var teLast = 0
    var parserStep = 0
    var headerCount = 0
    var teShort = Int.MAX_VALUE / 64
    var teLong = Int.MAX_VALUE / 64
    var teDelta = Int.MAX_VALUE / 64
    var minCountBitForFound = Int.MAX_VALUE / 64
    var callback: ((FProto) -> Unit)? = null

    abstract fun feed(level: Boolean, duration: Int)

    protected fun addBit(bit: Int) { decodeData = (decodeData shl 1) or (bit.toLong() and 1L); decodeCountBit++ }
    protected fun hit() { callback?.invoke(this) }
    protected fun dd(x: Int, y: Int): Int = FG.dd(x, y)
}
