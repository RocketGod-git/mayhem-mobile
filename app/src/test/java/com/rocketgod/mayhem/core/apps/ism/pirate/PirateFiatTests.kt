// ProtoPirate Fiat, Chrysler and Renault decoders checked against the C golden fixtures.
package com.rocketgod.mayhem.core.apps.ism.pirate

import org.junit.Test

class PirateFiatTests {
    @Test fun fiatV0() = PPFixture.check("fiat_v0") { PPFiatV0() }
    @Test fun fiatV1() = PPFixture.check("fiat_v1") { PPFiatV1() }
    @Test fun fiatV2() = PPFixture.check("fiat_v2") { PPFiatV2() }
    @Test fun chryslerV0() = PPFixture.check("chrysler_v0") { PPChryslerV0() }
    @Test fun renaultV0() = PPFixture.check("renault_v0") { PPRenaultV0() }
    @Test fun renaultV1() = PPFixture.check("renault_v1") { PPRenaultV1() }
}
