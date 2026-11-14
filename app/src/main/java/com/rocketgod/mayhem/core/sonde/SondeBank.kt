package com.rocketgod.mayhem.core.sonde

/**
 * Every sonde decoder a channel runs, side by side on the same discriminator: whichever finds its sync word and
 * passes its checks names the type. The Kotlin twin of web/src/dsp/sonde/bank.ts (and bank-a/b/c.ts) and
 * SondeBank.swift. A new type goes into its group's makeBank function; nothing else changes.
 */
interface ChannelDecoder {
    val name: String
    /** One FM discriminator sample (radians per sample) at the channel rate. */
    fun push(x: Double)
    /** A decoder that wants its channel's frequency (iMet IDs are made from it) overrides this with a field (non-null);
     *  the channel keeps it set. Null: not wanted. */
    var hz: Long?
        get() = null
        set(@Suppress("UNUSED_PARAMETER") v) {}
}

/** A framer and a frame decoder: the shape most types take. [decode] returns null, one frame or several. */
class Framed(
    override val name: String, baud: Double, rate: Double, header: String, syms: Int, maxErr: Int,
    decode: (FloatArray) -> List<SondeFrame>?, sink: SondeSink,
) : ChannelDecoder {
    private val fr = FskFramer(baud, rate, header, syms, maxErr, { soft, _ ->
        val r = decode(soft)
        if (r != null) for (f in r) if (f.serial.isNotEmpty()) sink(f)
    })
    override fun push(x: Double) = fr.push(x)
}

object SondeBank {
    fun makeDecoders(rate: Double, sink: SondeSink): List<ChannelDecoder> {
        val rs41 = Rs41Decoder()
        return listOf<ChannelDecoder>(
            Framed("RS41", Rs41.BAUD.toDouble(), rate, Rs41.HEADER, Rs41.SYMS, 3, { s -> rs41.decode(s)?.let { listOf(it) } }, sink),
        ) + makeBankA(rate, sink) + makeBankB(rate, sink) + makeBankC(rate, sink)
    }

    /** Decoders for Graw DFM-06/09/17, Meteomodem M10/M20, MTS01. */
    fun makeBankA(rate: Double, sink: SondeSink): List<ChannelDecoder> {
        val m10 = M10Decoder()
        return listOf(
            DfmChannel(rate, sink),
            // M10 and M20 share the sync and the line code; the checksum and the type byte tell them apart
            Framed("M10", M10.BAUD.toDouble(), rate, M10.HEADER, M10.SYMS, 2, { s -> m10.decode(s)?.let { listOf(it) } }, sink),
            Mts01Channel(rate, sink),
        )
    }

    /** Decoders for Vaisala RS92, Lockheed Martin LMS6-403 / LMSX, LMS6-1680 (Mk2a), MRZ. */
    fun makeBankB(rate: Double, sink: SondeSink): List<ChannelDecoder> = makeBankBDecoders(rate, sink)

    /** Decoders for InterMet iMet-1/iMet-4 (AFSK), iMet-54, Meisei iMS-100 / RS-11G. */
    fun makeBankC(rate: Double, sink: SondeSink): List<ChannelDecoder> = listOf(
        ImetDecoder(rate, sink),
        Imet54Channel(rate, sink),
        MeiseiChannel(rate, sink),
    )
}
