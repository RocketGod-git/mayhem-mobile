// ProtoPirate PSA and VAG decoders checked against the C golden fixtures.
package com.rocketgod.mayhem.core.apps.ism.pirate

import org.junit.Test

class PiratePsaVagTests {
    @Test fun psa() = PPFixture.check("psa") { PPPsa() }
    @Test fun vag() = PPFixture.check("vag") { PPVag() }
}
